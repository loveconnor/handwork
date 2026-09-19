export function parseLine(text,line,onValue,onError){
 if(!text.trim())return;
 let value;
 try{value=JSON.parse(text);}
 catch(error){onError(error,line);return;}
 onValue(value);
}
