import {receiptKey} from './keys.js';
export function transfer(store,req){
 const key=receiptKey(req);
 if(store.receipts.has(key)){
  const receipt=store.receipts.get(key);
  if(receipt.from!==req.from||receipt.to!==req.to||receipt.amount!==req.amount)throw Error('conflicting payload');
  return receipt;
 }
 if(!Number.isSafeInteger(req.amount)||req.amount<=0)throw Error('invalid amount');
 const a=`${req.tenant}:${req.from}`,b=`${req.tenant}:${req.to}`;
 if(a===b)throw Error('accounts must be distinct');
 if(!store.accounts.has(a)||!store.accounts.has(b))throw Error('missing account');
 const before=store.accounts.get(a),target=store.accounts.get(b);
 if(!Number.isSafeInteger(before)||!Number.isSafeInteger(target))throw Error('invalid balance');
 if(before<req.amount)throw Error('insufficient funds');
 const debit=before-req.amount,credit=target+req.amount;
 if(!Number.isSafeInteger(debit)||!Number.isSafeInteger(credit))throw Error('unsafe balance');
 const receipt={from:req.from,to:req.to,amount:req.amount};
 store.accounts.set(a,debit);
 store.accounts.set(b,credit);
 store.receipts.set(key,receipt);return receipt;
}
