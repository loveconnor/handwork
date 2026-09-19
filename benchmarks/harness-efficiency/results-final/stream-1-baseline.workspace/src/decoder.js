import {parseLine} from './parse.js';

export function createDecoder(onValue, onError) {
  let line = 0;
  let buffer = '';
  let closed = false;

  function drain() {
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const text = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      parseLine(text, ++line, onValue, onError);
    }
  }

  return {
    push(chunk) {
      if (closed) throw new Error('Decoder is closed');
      buffer += chunk;
      drain();
    },
    end() {
      if (closed) return;
      closed = true;
      drain();
      const text = buffer;
      buffer = '';
      if (text) parseLine(text, ++line, onValue, onError);
    }
  };
}
