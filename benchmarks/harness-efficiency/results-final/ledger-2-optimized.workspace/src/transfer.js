import {receiptKey} from './keys.js';
export function transfer(store,req){
 const {tenant,from,to,amount}=req;
 if(!Number.isSafeInteger(amount)||amount<=0)throw Error('invalid amount');
 const a=`${tenant}:${from}`,b=`${tenant}:${to}`;
 if(a===b)throw Error('source and target must differ');
 const key=receiptKey(req);
 if(store.receipts.has(key)){
  const receipt=store.receipts.get(key);
  if(receipt.from!==from||receipt.to!==to||receipt.amount!==amount)throw Error('idempotency conflict');
  return receipt;
 }
 if(!store.accounts.has(a)||!store.accounts.has(b))throw Error('missing account');
 const before=store.accounts.get(a),target=store.accounts.get(b);
 if(!Number.isSafeInteger(before)||!Number.isSafeInteger(target))throw Error('invalid balance');
 if(before<amount)throw Error('insufficient funds');
 const sourceBalance=before-amount,targetBalance=target+amount;
 if(!Number.isSafeInteger(sourceBalance)||!Number.isSafeInteger(targetBalance))throw Error('unsafe balance');
 const receipt={from,to,amount};
 store.accounts.set(a,sourceBalance);
 store.accounts.set(b,targetBalance);
 store.receipts.set(key,receipt);return receipt;
}
