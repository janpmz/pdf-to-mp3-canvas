document.getElementById('copyGuide').onclick = async event => {
  try { await navigator.clipboard.writeText(document.getElementById('guide').innerText); event.target.textContent = 'Copied'; }
  catch { event.target.textContent = 'Select the guide and copy it'; }
};
