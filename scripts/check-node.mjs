const [major] = process.versions.node.split('.').map(Number);
const minimum = 25;

if (major < minimum) {
  console.error(
    `Node ${minimum}+ required (.nvmrc). Current: ${process.version}.`,
  );
  console.error('Fix: nvm install && nvm use');
  process.exit(1);
}
