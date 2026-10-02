(() => {
  const $ = (selector, parent = document) => parent.querySelector(selector);
  const loginView = $('#loginView');
  const dashboardView = $('#dashboardView');
  const loginForm = $('#loginForm');
  let csrfToken = '';
  let products = [];
  let orders = [];
  let inquiries = [];
  let subadmins = [];
  let adminRole = 'owner';
  let currentView = 'overview';
  let toastTimeout;

  const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const dateLabel = (date) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(date));
  const money = (amount, currency = 'INR') => new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(Number(amount) || 0);
  const statusName = (status) => ({ new: 'New', contacted: 'Contacted', confirmed: 'Confirmed', completed: 'Completed', cancelled: 'Cancelled', unread: 'Awaiting reply', replied: 'Replied' })[status] || status;
  const flash = (message, isError = false) => {
    const toast = $('#toast');
    toast.textContent = message;
    toast.classList.toggle('is-error', isError);
    toast.classList.add('visible');
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toast.classList.remove('visible'), 3600);
  };
  async function request(url, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
    if (options.method && options.method !== 'GET' && csrfToken) headers.set('X-CSRF-Token', csrfToken);
    const sendRequest = () => fetch(url, { ...options, headers, credentials: 'same-origin' });
    let response = await sendRequest();
    if (response.status === 403 && csrfToken) {
      const failure = await response.clone().json().catch(() => ({}));
      if (String(failure.error || '').includes('Security token expired')) {
        const sessionResponse = await fetch('/api/admin/session', { credentials: 'same-origin', cache: 'no-store' });
        if (sessionResponse.ok) {
          const session = await sessionResponse.json();
          csrfToken = session.csrfToken;
          headers.set('X-CSRF-Token', csrfToken);
          response = await sendRequest();
        } else if (sessionResponse.status === 401) {
          showLogin();
        }
      }
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && dashboardView && !dashboardView.hidden) showLogin();
      throw new Error(data.error || `Request failed (${response.status}).`);
    }
    return data;
  }
  function showLogin() {
    csrfToken = '';
    dashboardView.hidden = true;
    loginView.hidden = false;
    $('#loginPassword').value = '';
  }
  function showDashboard(email, role = 'owner') {
    loginView.hidden = true;
    dashboardView.hidden = false;
    adminRole = role;
    $('#adminEmail').textContent = email;
    $('#adminRoleLabel').textContent = role === 'owner' ? 'Primary admin' : 'Sub-admin';
    $('#adminAvatar').textContent = email.charAt(0).toUpperCase();
    $('#navSubadmins').hidden = role !== 'owner';
    $('#todayLabel').textContent = new Intl.DateTimeFormat(undefined, { dateStyle: 'full' }).format(new Date());
    switchView('overview');
    refreshAll().catch((error) => flash(error.message, true));
  }
  async function startSession() {
    const session = await request('/api/admin/session');
    csrfToken = session.csrfToken;
    showDashboard(session.email, session.role);
  }
  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('.login-submit');
    button.disabled = true;
    $('#loginError').hidden = true;
    try {
      const form = new FormData(loginForm);
      const result = await request('/api/admin/login', { method: 'POST', body: JSON.stringify({ email: form.get('email'), password: form.get('password') }) });
      csrfToken = result.csrfToken;
      loginForm.reset();
      showDashboard(result.email, result.role);
    } catch (error) {
      $('#loginError').textContent = error.message;
      $('#loginError').hidden = false;
    } finally { button.disabled = false; }
  });
  $('#logoutButton').addEventListener('click', async () => {
    try { await request('/api/admin/logout', { method: 'POST', body: '{}' }); } catch {}
    showLogin();
  });

  function switchView(name) {
    if (name === 'subadmins' && adminRole !== 'owner') name = 'overview';
    currentView = name;
    document.querySelectorAll('.dashboard-content').forEach((section) => { section.hidden = section.id !== `view-${name}`; });
    document.querySelectorAll('.side-link').forEach((button) => button.classList.toggle('active', button.dataset.view === name));
    const labels = { overview: 'Overview', products: 'Products', orders: 'Orders', inquiries: 'Customer enquiries', subadmins: 'Sub-admins' };
    $('#pageBreadcrumb').textContent = labels[name] || 'Overview';
    $('#sidebar').classList.remove('mobile-open');
    if (name === 'products') renderProducts();
    if (name === 'orders') renderOrders();
    if (name === 'inquiries') renderInquiries();
    if (name === 'subadmins') loadSubadmins().catch((error) => flash(error.message, true));
  }
  document.querySelectorAll('[data-view], [data-jump]').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.view || button.dataset.jump)));
  $('#menuToggle').addEventListener('click', () => $('#sidebar').classList.toggle('mobile-open'));

  async function refreshAll() {
    const [productData, orderData, inquiryData, health] = await Promise.all([
      request('/api/admin/products'), request('/api/admin/orders'), request('/api/admin/inquiries'), request('/api/health'),
    ]);
    products = productData.products;
    orders = orderData.orders;
    inquiries = inquiryData.inquiries;
    $('#setupWarning').hidden = health.smtpConfigured !== true;
    $('#statProducts').textContent = products.length.toLocaleString();
    const newOrders = orders.filter((order) => order.status === 'new');
    const openInquiries = inquiries.filter((inquiry) => inquiry.status !== 'replied');
    $('#statOrders').textContent = newOrders.length.toLocaleString();
    $('#statInquiries').textContent = openInquiries.length.toLocaleString();
    $('#statValue').textContent = money(newOrders.reduce((sum, order) => sum + order.subtotal, 0));
    $('#navProductCount').textContent = String(products.length);
    $('#navOrderCount').textContent = String(newOrders.length);
    $('#navInquiryCount').textContent = String(openInquiries.length);
    $('#productTotal').textContent = `${products.length} products`;
    $('#orderTotal').textContent = `${orders.length} orders`;
    $('#inquiryTotal').textContent = `${inquiries.length} enquiries`;
    renderCategoryOptions();
    renderRecent();
    switchView(currentView);
  }
  function renderSubadmins() {
    $('#subadminCount').textContent = `${subadmins.length} account${subadmins.length === 1 ? '' : 's'}`;
    $('#subadminsEmpty').hidden = subadmins.length > 0;
    $('#subadminsList').innerHTML = subadmins.map((user) => `<article class="compact-row"><span class="compact-icon green">♙</span><span class="compact-copy"><strong>${escapeHtml(user.email)}</strong><span>Sub-admin · Added ${escapeHtml(dateLabel(user.created_at))}</span></span><button class="button button-outline" data-remove-subadmin="${escapeHtml(user.id)}" type="button">Remove</button></article>`).join('');
  }
  async function loadSubadmins() {
    const result = await request('/api/admin/subadmins');
    subadmins = result.subadmins;
    renderSubadmins();
  }
  $('#subadminForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = $('button[type="submit"]', form);
    button.disabled = true;
    try {
      const values = Object.fromEntries(new FormData(form));
      await request('/api/admin/subadmins', { method: 'POST', body: JSON.stringify(values) });
      form.reset();
      await loadSubadmins();
      flash('Sub-admin account created.');
    } catch (error) { flash(error.message, true); }
    finally { button.disabled = false; }
  });
  $('#subadminsList').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-remove-subadmin]');
    if (!button) return;
    button.disabled = true;
    try {
      await request(`/api/admin/subadmins/${button.dataset.removeSubadmin}`, { method: 'DELETE' });
      await loadSubadmins();
      flash('Sub-admin removed and active sessions revoked.');
    } catch (error) { flash(error.message, true); }
    finally { if (button.isConnected) button.disabled = false; }
  });
  function renderCategoryOptions() {
    const select = $('#productCategory');
    const current = select.value;
    const categories = [...new Set(products.map((product) => product.page))].sort();
    select.innerHTML = '<option value="all">All collections</option>' + categories.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category.replaceAll('_', ' '))}</option>`).join('');
    if ([...select.options].some((option) => option.value === current)) select.value = current;
  }
  function renderRecent() {
    const latestOrders = orders.slice(0, 4);
    $('#recentOrders').innerHTML = latestOrders.length ? latestOrders.map((order) => `<article class="compact-row"><span class="compact-icon green">▤</span><span class="compact-copy"><strong>${escapeHtml(order.name)} <small>${escapeHtml(order.reference)}</small></strong><span>${escapeHtml(order.items.length)} item${order.items.length === 1 ? '' : 's'} · ${escapeHtml(dateLabel(order.created_at))}</span></span><span class="status-badge status-${escapeHtml(order.status)}">${escapeHtml(statusName(order.status))}</span></article>`).join('') : '<p class="subtle-empty">New customer orders will appear here.</p>';
    const latestMessages = inquiries.filter((item) => item.status !== 'replied').slice(0, 4);
    $('#recentInquiries').innerHTML = latestMessages.length ? latestMessages.map((item) => `<article class="compact-row"><span class="compact-icon violet">✉</span><span class="compact-copy"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.subject)} · ${escapeHtml(dateLabel(item.created_at))}</span></span><span class="status-badge status-unread">New</span></article>`).join('') : '<p class="subtle-empty">You’re all caught up. No messages need a reply.</p>';
  }

  function productMatches(product) {
    const query = $('#productSearch').value.trim().toLowerCase();
    const category = $('#productCategory').value;
    return (category === 'all' || product.page === category) && (!query || `${product.name} ${product.sku} ${product.category}`.toLowerCase().includes(query));
  }
  function renderProducts() {
    if (!products.length) return;
    const visible = products.filter(productMatches);
    $('#productsEmpty').hidden = visible.length > 0;
    $('#productsBody').innerHTML = visible.map((product) => `<tr data-product-sku="${escapeHtml(product.sku)}"><td><div class="product-name">${escapeHtml(product.name)}</div><small class="product-category">${escapeHtml(product.page.replaceAll('_', ' '))}</small></td><td><span class="sku-tag">${escapeHtml(product.sku)}</span></td><td><input class="price-input" data-price="inr" aria-label="INR price for ${escapeHtml(product.sku)}" value="${escapeHtml(product.inr)}" maxlength="60" /></td><td><input class="price-input" data-price="usd" aria-label="USD price for ${escapeHtml(product.sku)}" value="${escapeHtml(product.usd)}" maxlength="60" /></td><td><label class="photo-picker" title="Upload a new product photo"><img src="${escapeHtml(product.image_url)}" alt="" loading="lazy" /><span>↥</span><input type="file" accept="image/jpeg,image/png,image/webp" data-photo="${escapeHtml(product.sku)}" aria-label="Upload photo for ${escapeHtml(product.sku)}" /></label></td><td><button class="button button-save" data-save="${escapeHtml(product.sku)}" type="button">Save</button></td></tr>`).join('');
  }
  $('#productSearch').addEventListener('input', renderProducts);
  $('#productCategory').addEventListener('change', renderProducts);
  $('#productsBody').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-save]');
    if (!button) return;
    const row = button.closest('tr');
    button.disabled = true;
    try {
      const result = await request(`/api/admin/products/${encodeURIComponent(button.dataset.save)}`, { method: 'PATCH', body: JSON.stringify({ inr: $('[data-price="inr"]', row).value, usd: $('[data-price="usd"]', row).value }) });
      Object.assign(products.find((product) => product.sku === button.dataset.save), result.product);
      flash(`${button.dataset.save} saved. Storefront prices will refresh shortly.`);
      button.textContent = 'Saved ✓';
      setTimeout(() => { if (button.isConnected) button.textContent = 'Save'; }, 1600);
    } catch (error) { flash(error.message, true); }
    finally { button.disabled = false; }
  });
  $('#productsBody').addEventListener('change', async (event) => {
    const input = event.target.closest('[data-photo]');
    const file = input?.files?.[0];
    if (!file) return;
    const row = input.closest('tr');
    const image = $('.photo-picker img', row);
    const previous = image.src;
    image.src = URL.createObjectURL(file);
    try {
      const form = new FormData(); form.append('image', file);
      const uploaded = await request('/api/admin/upload', { method: 'POST', body: form });
      const result = await request(`/api/admin/products/${encodeURIComponent(input.dataset.photo)}`, { method: 'PATCH', body: JSON.stringify({ image_url: uploaded.image_url }) });
      Object.assign(products.find((product) => product.sku === input.dataset.photo), result.product);
      image.src = uploaded.image_url;
      flash(`Photo updated for ${input.dataset.photo}.`);
    } catch (error) { image.src = previous; flash(error.message, true); }
    finally { input.value = ''; }
  });

  function renderOrders() {
    const query = $('#orderSearch').value.trim().toLowerCase();
    const filter = $('#orderFilter').value;
    const visible = orders.filter((order) => (filter === 'all' || order.status === filter) && (!query || `${order.name} ${order.company || ''} ${order.email} ${order.reference} ${order.phone} ${order.city || ''}`.toLowerCase().includes(query)));
    $('#ordersEmpty').hidden = visible.length > 0;
    $('#ordersList').innerHTML = visible.map((order) => `<article class="record-card"><div class="record-top"><div><span class="order-reference">${escapeHtml(order.reference)}</span><span class="status-badge status-${escapeHtml(order.status)}">${escapeHtml(statusName(order.status))}</span><h2>${escapeHtml(order.name)}${order.company ? ` · ${escapeHtml(order.company)}` : ''}</h2><p class="record-contact"><a href="mailto:${escapeHtml(order.email)}">${escapeHtml(order.email)}</a> · <a href="tel:${escapeHtml(order.phone)}">${escapeHtml(order.phone)}</a></p>${order.address1 ? `<p class="record-contact">Ship to: ${escapeHtml([order.address1, order.address2, order.city, order.state, order.postalCode, order.country].filter(Boolean).join(', '))}${order.gstNumber ? ` · GST ${escapeHtml(order.gstNumber)}` : ''}</p>` : ''}</div><time>${escapeHtml(dateLabel(order.created_at))}</time></div><div class="order-items">${order.items.map((item) => `<div><span><strong>${escapeHtml(item.sku)}</strong> ${escapeHtml(item.name)} × ${escapeHtml(item.quantity)}</span><span>${escapeHtml(item.inr)} INR · ${escapeHtml(item.usd)} USD</span></div>`).join('')}</div><div class="record-bottom"><strong>Indicative total · ${escapeHtml(order.currency)} ${order.currency === 'INR' ? money(order.subtotal).replace('₹', '').trim() : money(order.subtotal, order.currency).replace(/[A-Z]{3}/g, '').trim()}</strong><div class="record-actions"><select data-order-status="${order.id}" aria-label="Order status"><option value="new" ${order.status === 'new' ? 'selected' : ''}>New</option><option value="contacted" ${order.status === 'contacted' ? 'selected' : ''}>Contacted</option><option value="confirmed" ${order.status === 'confirmed' ? 'selected' : ''}>Confirmed</option><option value="completed" ${order.status === 'completed' ? 'selected' : ''}>Completed</option><option value="cancelled" ${order.status === 'cancelled' ? 'selected' : ''}>Cancelled</option></select><button class="button button-outline" data-order-email="${order.id}" type="button">Email customer</button></div></div></article>`).join('');
  }
  $('#orderSearch').addEventListener('input', renderOrders);
  $('#orderFilter').addEventListener('change', renderOrders);
  $('#ordersList').addEventListener('change', async (event) => {
    const select = event.target.closest('[data-order-status]');
    if (!select) return;
    try { await request(`/api/admin/orders/${select.dataset.orderStatus}`, { method: 'PATCH', body: JSON.stringify({ status: select.value }) }); const order = orders.find((item) => String(item.id) === select.dataset.orderStatus); order.status = select.value; flash('Order status updated.'); refreshAll(); }
    catch (error) { flash(error.message, true); }
  });
  $('#ordersList').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-order-email]');
    if (!button) return;
    const order = orders.find((item) => String(item.id) === button.dataset.orderEmail);
    const message = window.prompt(`Write an email to ${order.name}:`, `Hello ${order.name},\n\nThank you for your order ${order.reference}. We will be in touch shortly.\n\nBrannEco`);
    if (!message?.trim()) return;
    try { await request(`/api/admin/orders/${order.id}`, { method: 'PATCH', body: JSON.stringify({ status: order.status, emailCustomer: true, message }) }); flash(`Email sent to ${order.email}.`); }
    catch (error) { flash(error.message, true); }
  });

  function renderInquiries() {
    const query = $('#inquirySearch').value.trim().toLowerCase();
    const filter = $('#inquiryFilter').value;
    const visible = inquiries.filter((item) => (filter === 'all' || item.status === filter) && (!query || `${item.name} ${item.phone || ''} ${item.email} ${item.subject} ${item.message}`.toLowerCase().includes(query)));
    $('#inquiriesEmpty').hidden = visible.length > 0;
    $('#inquiriesList').innerHTML = visible.map((item) => {
      const phoneDigits = String(item.phone || '').replace(/\D/g, '');
      const contactPhone = item.phone ? ` · <a href="tel:${escapeHtml(item.phone)}">${escapeHtml(item.phone)}</a>` : ' · WhatsApp number not provided';
      return `<article class="record-card inquiry-card"><div class="record-top"><div><span class="status-badge status-${escapeHtml(item.status)}">${escapeHtml(statusName(item.status))}</span><h2>${escapeHtml(item.subject)}</h2><p class="record-contact">From <strong>${escapeHtml(item.name)}</strong> · <a href="mailto:${escapeHtml(item.email)}">${escapeHtml(item.email)}</a>${contactPhone}</p></div><time>${escapeHtml(dateLabel(item.created_at))}</time></div><blockquote>${escapeHtml(item.message)}</blockquote>${item.reply ? `<div class="previous-reply"><strong>Previous ${escapeHtml(item.reply_channel || 'reply')}</strong><p>${escapeHtml(item.reply)}</p></div>` : ''}<form class="reply-form" data-reply-form="${escapeHtml(item.id)}"><label for="reply-${escapeHtml(item.id)}">WhatsApp reply to ${escapeHtml(item.name)}</label><textarea id="reply-${escapeHtml(item.id)}" name="reply" rows="3" maxlength="5000" placeholder="Write a thoughtful reply…" required>${item.status === 'replied' ? escapeHtml(item.reply || '') : ''}</textarea><div class="reply-footer"><span>${phoneDigits.length >= 7 && phoneDigits.length <= 15 ? 'Open WhatsApp to send. Confirm below after the message is sent.' : 'A WhatsApp number with country code is required to reply.'}</span><div class="record-actions"><button class="button button-outline" type="button" data-open-whatsapp="${escapeHtml(item.id)}" ${phoneDigits.length < 7 || phoneDigits.length > 15 ? 'disabled' : ''}>Open WhatsApp</button><button class="button button-primary" type="submit" ${phoneDigits.length < 7 || phoneDigits.length > 15 ? 'disabled' : ''}>Mark replied</button></div></div></form></article>`;
    }).join('');
  }
  $('#inquirySearch').addEventListener('input', renderInquiries);
  $('#inquiryFilter').addEventListener('change', renderInquiries);
  $('#inquiriesList').addEventListener('click', (event) => {
    const button = event.target.closest('[data-open-whatsapp]');
    if (!button) return;
    const inquiry = inquiries.find((item) => String(item.id) === button.dataset.openWhatsapp);
    const form = button.closest('[data-reply-form]');
    const reply = $('textarea[name="reply"]', form).value.trim();
    if (!reply) return flash('Write a reply before opening WhatsApp.', true);
    const phoneDigits = String(inquiry?.phone || '').replace(/\D/g, '');
    if (!inquiry || phoneDigits.length < 7 || phoneDigits.length > 15) return flash('This enquiry has no valid WhatsApp number.', true);
    const message = `Hi ${inquiry.name},\n\n${reply}\n\n- BrannEco`;
    window.open(`https://wa.me/${phoneDigits}?text=${encodeURIComponent(message)}`, '_blank', 'noopener,noreferrer');
  });
  $('#inquiriesList').addEventListener('submit', async (event) => {
    const form = event.target.closest('[data-reply-form]');
    if (!form) return;
    event.preventDefault();
    const button = $('button[type="submit"]', form);
    const reply = new FormData(form).get('reply');
    button.disabled = true;
    try {
      await request(`/api/admin/inquiries/${form.dataset.replyForm}/reply`, { method: 'POST', body: JSON.stringify({ reply, channel: 'whatsapp' }) });
      flash('Enquiry marked as replied on WhatsApp.');
      const inquiry = inquiries.find((item) => String(item.id) === form.dataset.replyForm);
      inquiry.reply = reply; inquiry.reply_channel = 'whatsapp'; inquiry.status = 'replied'; inquiry.replied_at = new Date().toISOString();
      renderInquiries(); refreshAll();
    } catch (error) { flash(error.message, true); }
    finally { button.disabled = false; }
  });

  startSession().catch(() => showLogin());
})();
