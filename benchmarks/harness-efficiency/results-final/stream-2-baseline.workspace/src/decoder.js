import {parseLine} from './parse.js';
export function createDecoder(onValue,onError){
 let line=0,buffer='',closed=false;
 function drain(){
  let boundary;
  while((boundary=buffer.indexOf('\n'))!==-1){
   const text=buffer.slice(0,boundary);
   buffer=buffer.slice(boundary+1);
   parseLine(text,++line,onValue,onError);
  }
 }
 return {
  push(chunk){
   if(closed)throw new Error('Decoder is closed');
   buffer+=chunk;
   drain();
  },
  end(){
   if(closed)return;
   closed=true;
   drain();
   const text=buffer;
   buffer='';
   if(text.length)parseLine(text,++line,onValue,onError);
  }
 };
}
