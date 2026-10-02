(() => {
  if (location.protocol === 'file:' || location.pathname.endsWith('/admin.html')) return;
  const category = location.pathname.split('/').pop().replace(/\.html$/i, '') || 'index';
  const products = new Map();
  const updateProduct = (product) => {
    const previous = products.get(product.sku);
    const changed = !previous || ['name', 'inr', 'usd', 'image_url'].some((key) => previous[key] !== product[key]);
    products.set(product.sku, product);
    if (!changed) return false;
    document.querySelectorAll('.catsec').forEach((section) => {
      const row = [...section.querySelectorAll('td.sku')].find((cell) => cell.textContent.trim() === product.sku)?.closest('tr');
      if (!row) return;
      const table = row.closest('table');
      const inrIndex = Number(table.dataset.inrIndex);
      const usdIndex = Number(table.dataset.usdIndex);
      const inrCell = row.cells[inrIndex];
      const usdCell = row.cells[usdIndex];
      if (inrCell) { inrCell.dataset.basePrice = product.inr; inrCell.textContent = product.inr; }
      if (usdCell) { usdCell.dataset.basePrice = product.usd; usdCell.textContent = product.usd; }
      const button = row.querySelector('.addrow');
      if (button) {
        button.dataset.inr = /^\d+(?:\.\d+)?$/.test(product.inr) ? product.inr : '';
        button.dataset.usd = /^\d+(?:\.\d+)?$/.test(product.usd) ? product.usd : '';
        button.dataset.inrText = product.inr;
        button.dataset.usdText = product.usd;
      }
      const option = section.querySelector(`.variant-select option[data-sku="${CSS.escape(product.sku)}"]`);
      if (option && !option.dataset.productLabel) option.dataset.productLabel = option.textContent.trim().split(/\s+[·—]\s+/)[0];
      const image = section.querySelector('.cat-photo');
      if (image && product.image_url) {
        image.dataset.productImages ||= '{}';
        const saved = JSON.parse(image.dataset.productImages);
        saved[product.sku] = product.image_url;
        image.dataset.productImages = JSON.stringify(saved);
      }
    });
    return true;
  };
  const refreshCatalog = async () => {
    try {
      const response = await fetch(`/api/catalog?category=${encodeURIComponent(category)}`, { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) return;
      const data = await response.json();
      let changed = false;
      data.products.forEach((product) => { changed = updateProduct(product) || changed; });
      if (changed) document.dispatchEvent(new CustomEvent('branneco:catalogupdated', { detail: { products } }));
    } catch {}
  };
  if (document.querySelector('.catsec')) {
    refreshCatalog();
    window.setInterval(() => { if (!document.hidden) refreshCatalog(); }, 30_000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshCatalog(); });
  }

  document.addEventListener('change', (event) => {
    const select = event.target.closest('.variant-select');
    if (!select) return;
    const section = select.closest('.catsec');
    const product = products.get(select.selectedOptions[0]?.dataset.sku);
    const image = section?.querySelector('.cat-photo');
    if (!product || !image) return;
    image.src = product.image_url;
    image.closest('a')?.setAttribute('href', product.image_url);
  });

  const trigger = document.createElement('button');
  trigger.className = 'customer-help-trigger';
  trigger.type = 'button';
  trigger.textContent = '✉  Ask us a question';
  trigger.setAttribute('aria-expanded', 'false');
  const whatsappNumber = '919039220991';
  const panel = document.createElement('section');
  panel.className = 'customer-help-panel';
  panel.setAttribute('aria-label', 'Contact BrannEco');
  panel.hidden = true;
  panel.innerHTML = `<div class="customer-help-head"><div><strong>We’re happy to help</strong><span>Your query opens in WhatsApp for you to send.</span></div><button type="button" class="customer-help-close" aria-label="Close contact form">×</button></div><form class="customer-help-form"><label>Your name<input name="name" autocomplete="name" required maxlength="120" /></label><label>Email address<input name="email" type="email" autocomplete="email" required maxlength="254" /></label><label>WhatsApp number<input name="phone" type="tel" autocomplete="tel" inputmode="tel" placeholder="+91 98765 43210" required minlength="7" maxlength="32" /></label><label>What can we help with?<textarea name="message" rows="4" required minlength="8" maxlength="5000" placeholder="Product questions, custom orders, delivery…"></textarea></label><button type="submit">Continue in WhatsApp →</button><p class="customer-help-status" aria-live="polite"></p></form>`;
  document.body.append(trigger, panel);
  const toggle = (open) => {
    panel.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
    if (open) panel.querySelector('input').focus();
  };
  trigger.addEventListener('click', () => toggle(panel.hidden));
  panel.querySelector('.customer-help-close').addEventListener('click', () => toggle(false));
  panel.querySelector('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    const status = panel.querySelector('.customer-help-status');
    button.disabled = true; status.textContent = 'Sending…'; status.classList.remove('is-error');
    const data = Object.fromEntries(new FormData(form));
    const phoneDigits = String(data.phone).replace(/\D/g, '');
    if (phoneDigits.length < 7 || phoneDigits.length > 15) {
      status.textContent = 'Enter a valid WhatsApp number with country code.';
      status.classList.add('is-error');
      button.disabled = false;
      return;
    }
    const message = `Hi BrannEco, I have a query:\n\n${data.message}\n\nName: ${data.name}\nEmail: ${data.email}\nWhatsApp: ${data.phone}`;
    window.open(`https://wa.me/${whatsappNumber}?text=${encodeURIComponent(message)}`, '_blank', 'noopener,noreferrer');
    try {
      const response = await fetch('/api/inquiries', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...data, subject: 'Website enquiry' }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not send the message.');
      form.reset(); status.textContent = `WhatsApp is ready with your query (${result.reference}). Tap Send in WhatsApp to contact us.`;
    } catch (error) { status.textContent = `${error.message || 'Could not save your enquiry.'} WhatsApp is open with your query; tap Send to contact us.`; status.classList.add('is-error'); }
    finally { button.disabled = false; }
  });
})();
