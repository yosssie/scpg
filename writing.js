(() => {
  const readings = new Map();
  Object.entries(RUBY_DICTIONARY).forEach(([base, reading]) => {
    const item = { base, reading };
    readings.set(base, item);
    readings.set(reading, item);
  });
  const pattern = new RegExp([...readings.keys()].sort((a, b) => b.length - a.length).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  function addFurigana(root = document.body) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach((node) => {
      if (node.parentElement?.closest('ruby')) return;
      pattern.lastIndex = 0;
      if (!pattern.test(node.nodeValue)) return;
      pattern.lastIndex = 0;
      const fragment = document.createDocumentFragment(); let position = 0;
      node.nodeValue.replace(pattern, (matched, offset) => {
        fragment.append(document.createTextNode(node.nodeValue.slice(position, offset)));
        const item = readings.get(matched);
        const ruby = document.createElement('ruby'); ruby.append(document.createTextNode(item.base));
        const rt = document.createElement('rt'); rt.textContent = item.reading; ruby.append(rt); fragment.append(ruby);
        position = offset + matched.length;
      });
      fragment.append(document.createTextNode(node.nodeValue.slice(position)));
      node.replaceWith(fragment);
    });
  }
  window.addEventListener('DOMContentLoaded', () => {
    const toggle = document.querySelector('#furigana-toggle');
    const applyFuriganaVisibility = () => {
      document.querySelectorAll('ruby rt').forEach((rt) => { rt.hidden = !toggle.checked; });
    };
    addFurigana();
    applyFuriganaVisibility();
    toggle.addEventListener('change', applyFuriganaVisibility);
    new MutationObserver((changes) => {
      changes.forEach((change) => { if (change.type === 'childList') addFurigana(change.target); });
      applyFuriganaVisibility();
    }).observe(document.body, { childList: true, subtree: true });
  });
})();