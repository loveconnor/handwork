import {parseLine} from './parse.js';
export function createDecoder(onValue,onError){
 let line=0,buffer='',closed=false;
 return {
  push(chunk){
   if(closed)throw new Error('Decoder is closed');
   buffer+=chunk;
   let newline;
   while((newline=buffer.indexOf('\n'))!==-1){
    const text=buffer.slice(0,newline);
    buffer=buffer.slice(newline+1);
    parseLine(text,++line,onValue,onError);
   }
  },
  end(){
   if(closed)return;
   closed=true;
   while(buffer.length){
    const newline=buffer.indexOf('\n');
    const text=newline===-1?buffer:buffer.slice(0,newline);
    buffer=newline===-1?'':buffer.slice(newline+1);
    parseLine(text,++line,onValue,onError);
   }
  }
 };
}
