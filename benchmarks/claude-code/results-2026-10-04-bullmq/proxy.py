"""Local model-only egress. No request bodies, credentials or query strings logged."""
import http.server,http.client,ssl,socket,select,threading,time,json
from urllib.parse import urlsplit
ALLOWED={'chatgpt.com','api.openai.com','auth.openai.com','ab.chatgpt.com'}
class Handler(http.server.BaseHTTPRequestHandler):
 protocol_version='HTTP/1.1'
 def log_message(self,*args):pass
 def record(self,kind,target):
  with self.server.audit_lock:
   with open(self.server.audit,'a') as f:f.write(json.dumps({'time':time.time(),'kind':kind,'target':target})+'\n')
 def do_CONNECT(self):
  host,_,port=self.path.rpartition(':')
  if host not in ALLOWED or port!='443':
   self.record('denied',host);self.send_error(403);return
  self.record('connect',host)
  try:
   remote=socket.create_connection((host,443),timeout=30);remote.settimeout(None)
   self.send_response(200,'Connection established');self.end_headers()
   sockets=[self.connection,remote]
   while True:
    ready,_,_=select.select(sockets,[],[],300)
    if not ready:break
    for sock in ready:
     data=sock.recv(65536)
     if not data:return
     (remote if sock is self.connection else self.connection).sendall(data)
  except (OSError,ConnectionError):pass
  finally:
   if 'remote' in locals():remote.close()
   self.close_connection=True
 def forward(self):
  path=urlsplit(self.path)
  if path.scheme or path.path not in ['/backend-api/codex/responses','/backend-api/codex/models']:
   self.record('denied',path.path);self.send_error(403);return
  self.record(self.command,path.path)
  conn=http.client.HTTPSConnection('chatgpt.com',443,timeout=300,context=ssl.create_default_context())
  try:
   body=self.rfile.read(int(self.headers.get('Content-Length','0')))
   headers={k:v for k,v in self.headers.items() if k.lower() not in ['host','connection','proxy-connection','transfer-encoding']};headers['Host']='chatgpt.com'
   conn.request(self.command,self.path,body=body,headers=headers);response=conn.getresponse()
   self.send_response(response.status)
   for k,v in response.getheaders():
    if k.lower() not in ['connection','transfer-encoding','content-length']:self.send_header(k,v)
   self.send_header('Connection','close');self.end_headers()
   while True:
    data=response.read1(65536)
    if not data:break
    self.wfile.write(data);self.wfile.flush()
  except (OSError,ConnectionError):pass
  finally:conn.close();self.close_connection=True
 def do_GET(self):self.forward()
 def do_POST(self):self.forward()
def start(audit):
 server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler);server.daemon_threads=True;server.audit=str(audit);server.audit_lock=threading.Lock();threading.Thread(target=server.serve_forever,daemon=True).start();return server
