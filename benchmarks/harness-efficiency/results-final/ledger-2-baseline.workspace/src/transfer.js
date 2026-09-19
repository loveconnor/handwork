import {receiptKey} from './keys.js';
export function transfer(store,req){
 const key=receiptKey(req);
 if(store.receipts.has(key)){
  const receipt=store.receipts.get(key);
  if(receipt.from!==req.from||receipt.to!==req.to||receipt.amount!==req.amount)throw Error('idempotency conflict');
  return receipt;
 }
 if(!Number.isSafeInteger(req.amount)||req.amount<=0)throw Error('invalid amount');
 const a=`${req.tenant}:${req.from}`,b=`${req.tenant}:${req.to}`;
 if(a===b)throw Error('accounts must be distinct');
 if(!store.accounts.has(a))throw Error('missing source');
 if(!store.accounts.has(b))throw Error('missing target');
 const before=store.accounts.get(a),target=store.accounts.get(b);
 if(!Number.isSafeInteger(before)||!Number.isSafeInteger(target))throw Error('invalid balance');
 if(before<req.amount)throw Error('insufficient funds');
 const sourceAfter=before-req.amount,targetAfter=target+req.amount;
 if(!Number.isSafeInteger(sourceAfter)||!Number.isSafeInteger(targetAfter))throw Error('unsafe balance');
 store.accounts.set(a,sourceAfter);
 store.accounts.set(b,targetAfter);
 const receipt={from:req.from,to:req.to,amount:req.amount};store.receipts.set(key,receipt);return receipt;
}
