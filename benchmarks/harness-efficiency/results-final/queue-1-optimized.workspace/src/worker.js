export async function execute(fn, item, index) {
  try {
    return {status:'fulfilled', value:await fn(item,index)};
  } catch (reason) {
    return {status:'rejected', reason};
  }
}
