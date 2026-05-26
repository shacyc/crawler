// Interactive single-select prompt driven by arrow keys + Enter, with a
// numeric readline fallback when stdin is not a TTY.

const readline = require('readline');

function selectFromList(question, items) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;

    if (!stdin.isTTY) {
      const rl = readline.createInterface({ input: stdin, output: stdout });
      stdout.write(question + '\n');
      items.forEach((item, i) => stdout.write('  ' + (i + 1) + '. ' + item + '\n'));
      rl.question('Chọn (số thứ tự): ', (answer) => {
        rl.close();
        const n = Number(String(answer).trim());
        if (Number.isInteger(n) && n >= 1 && n <= items.length) {
          resolve(items[n - 1]);
        } else {
          resolve(null);
        }
      });
      return;
    }

    let index = 0;
    let drawn = false;

    const render = () => {
      if (drawn) {
        stdout.write('\x1b[' + items.length + 'A');
      }
      drawn = true;
      for (let i = 0; i < items.length; i++) {
        const selected = i === index;
        const marker = selected ? '\x1b[36m> ' : '  ';
        const reset = selected ? '\x1b[0m' : '';
        stdout.write('\x1b[2K' + marker + items[i] + reset + '\n');
      }
    };

    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      stdout.write('\x1b[?25h');
    };

    const onData = (key) => {
      if (key === '\u0003') {
        cleanup();
        process.exit(130);
      } else if (key === '\r' || key === '\n') {
        cleanup();
        resolve(items[index]);
      } else if (key === '\u001b[A' || key === 'k') {
        index = (index - 1 + items.length) % items.length;
        render();
      } else if (key === '\u001b[B' || key === 'j') {
        index = (index + 1) % items.length;
        render();
      }
    };

    stdout.write(question + '\n');
    stdout.write('\x1b[?25l');
    render();

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
  });
}

function ask(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(String(answer).trim());
    });
  });
}

module.exports = { selectFromList, ask };
