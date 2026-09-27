(() => {
  const cartButton = document.getElementById("cartBtn");
  const toast = document.getElementById("toast");
  const cartItems = document.getElementById("cartItems");
  const cartContent = document.getElementById("cartContent");
  const cartEmpty = document.getElementById("cartEmpty");
  const storageKey = "branneco-cart";
  const currencyStorageKey = "branneco-currency";
  const exchangeRates = { USD: 1, EUR: 0.92, GBP: 0.79, AED: 3.67 };
  const currencyLabels = {
    INR: "₹ INR",
    USD: "$ USD",
    EUR: "€ EUR",
    GBP: "£ GBP",
    AED: "AED",
  };
  const isLocalFile = location.protocol === "file:";
  const pageParams = new URLSearchParams(location.search);

  const getStoredCurrency = () => {
    const queryCurrency = isLocalFile ? pageParams.get("currency") : null;
    if (queryCurrency && queryCurrency in currencyLabels) return queryCurrency;
    try {
      const currency = localStorage.getItem(currencyStorageKey);
      return currency in currencyLabels ? currency : "INR";
    } catch {
      return "INR";
    }
  };

  let selectedCurrency = getStoredCurrency();
  const currencySelect = document.getElementById("currencySelect");
  if (currencySelect) {
    currencySelect.value = selectedCurrency;
    currencySelect.addEventListener("change", () => {
      selectedCurrency = currencySelect.value;
      try {
        localStorage.setItem(currencyStorageKey, selectedCurrency);
      } catch {}
      applySelectedCurrency();
      renderCartPage();
    });
  }

  const parsePrice = (value) => {
    const normalized = String(value).trim().replace(/,/g, "");
    if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null;
    return Number(normalized);
  };

  const loadCart = (storedCartOverride) => {
    try {
      const urlCart = isLocalFile ? pageParams.get("cart") : null;
      let storedCart = storedCartOverride;
      if (storedCart === undefined) {
        try {
          storedCart = localStorage.getItem(storageKey);
        } catch {}
      }
      const saved = JSON.parse(storedCart || urlCart || "{}");
      return Object.fromEntries(
        Object.entries(saved)
          .filter(([, product]) => product && typeof product === "object")
          .map(([sku, product]) => [
            sku,
            {
              sku,
              description: String(product.description || ""),
              inr: parsePrice(product.inr),
              usd: parsePrice(product.usd),
              inrText: String(product.inrText ?? product.inr ?? ""),
              usdText: String(product.usdText ?? product.usd ?? ""),
              quantity: Math.max(1, Math.floor(Number(product.quantity) || 1)),
            },
          ])
          .filter(([, product]) => product.inrText && product.usdText),
      );
    } catch {
      return {};
    }
  };

  let cart = loadCart();

  const updateCartButton = () => {
    const count = Object.values(cart).reduce(
      (total, product) => total + product.quantity,
      0,
    );
    if (cartButton) {
      cartButton.innerHTML = `<svg class="cart-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 4h2l2.2 10.3a2 2 0 0 0 2 1.6h8.3a2 2 0 0 0 1.9-1.4L21 8H6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><circle cx="10" cy="20" r="1.2" fill="currentColor"/><circle cx="18" cy="20" r="1.2" fill="currentColor"/></svg><span class="cart-label">Cart</span><span class="cart-count">${count}</span>`;
      cartButton.setAttribute("aria-label", `Cart, ${count} item${count === 1 ? "" : "s"}`);
    }
  };

  const saveCart = () => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(cart));
    } catch {}
    updateCartButton();
    renderCartPage();
  };

  window.addEventListener("storage", (event) => {
    if (event.key !== storageKey && event.key !== null) return;
    cart = loadCart(event.key === null || event.newValue === null ? "{}" : event.newValue);
    updateCartButton();
    renderCartPage();
  });

  const buildNavigationUrl = (href) => {
    const url = new URL(href, location.href);
    if (isLocalFile) {
      url.searchParams.set("currency", selectedCurrency);
      url.searchParams.set("cart", JSON.stringify(cart));
    }
    return url.href;
  };

  let toastTimeout;
  const showToast = () => {
    if (!toast) return;
    toast.classList.add("show");
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toast.classList.remove("show"), 1600);
  };

  const setupCatalogTables = () => {
    document.querySelectorAll(".catsec table").forEach((table) => {
      const header = table.rows[0];
      if (!header) return;

      const headings = Array.from(header.cells);
      const inrIndex = headings.findIndex((cell) => cell.textContent.includes("INR"));
      const usdIndex = headings.findIndex((cell) => cell.textContent.includes("Export"));
      if (inrIndex < 0 || usdIndex < 0) return;
      table.dataset.inrIndex = String(inrIndex);
      table.dataset.usdIndex = String(usdIndex);
      header.cells[inrIndex].dataset.priceCurrency = "INR";
      header.cells[usdIndex].dataset.priceCurrency = "USD";

      const hasOrderColumn = Boolean(table.querySelector(".addrow"));
      const orderIndex = hasOrderColumn ? headings.length - 1 : headings.length;
      if (hasOrderColumn) {
        header.cells[orderIndex].textContent = "Order";
      } else {
        const orderHeading = document.createElement("th");
        orderHeading.textContent = "Order";
        header.append(orderHeading);
      }

      Array.from(table.rows).slice(1).forEach((row) => {
        const cells = Array.from(row.cells);
        const inr = parsePrice(cells[inrIndex]?.textContent || "");
        const usd = parsePrice(cells[usdIndex]?.textContent || "");
        const inrText = cells[inrIndex]?.textContent.trim() || "";
        const usdText = cells[usdIndex]?.textContent.trim() || "";
        const sku = cells[0]?.textContent.trim();
        if (!sku || !inrText || !usdText) return;
        cells[inrIndex].dataset.basePrice = inrText;
        cells[usdIndex].dataset.basePrice = usdText;

        const description = cells
          .filter((_, index) => index !== 0 && index !== inrIndex && index !== usdIndex && index !== orderIndex)
          .map((cell) => cell.textContent.trim())
          .filter(Boolean)
          .join(" · ");
        const orderCell = hasOrderColumn ? cells[orderIndex] : row.insertCell(-1);
        const quantityInput = document.createElement("input");
        quantityInput.className = "cart-quantity";
        quantityInput.type = "number";
        quantityInput.min = "1";
        quantityInput.step = "1";
        quantityInput.value = "1";
        quantityInput.setAttribute("aria-label", `Quantity for ${sku}`);

        const addButton = document.createElement("button");
        addButton.className = "addrow";
        addButton.type = "button";
        addButton.textContent = "Add";
        addButton.setAttribute("aria-label", `Add ${sku} to cart`);
        addButton.dataset.sku = sku;
        addButton.dataset.description = description;
        addButton.dataset.inr = inr === null ? "" : String(inr);
        addButton.dataset.usd = usd === null ? "" : String(usd);
        addButton.dataset.inrText = inrText;
        addButton.dataset.usdText = usdText;

        const controls = document.createElement("div");
        controls.className = "cart-add-controls";
        controls.append(quantityInput, addButton);
        orderCell.replaceChildren(controls);
      });
    });
  };

  const applySelectedCurrency = () => {
    document.documentElement.dataset.currency = selectedCurrency;
    document.querySelectorAll(".catsec table[data-inr-index]").forEach((table) => {
      const inrIndex = Number(table.dataset.inrIndex);
      const usdIndex = Number(table.dataset.usdIndex);
      const inrHeader = table.rows[0].cells[inrIndex];
      const usdHeader = table.rows[0].cells[usdIndex];
      const useInr = selectedCurrency === "INR";

      inrHeader.hidden = !useInr;
      usdHeader.hidden = useInr;
      const activeHeader = useInr ? inrHeader : usdHeader;
      activeHeader.textContent = currencyLabels[selectedCurrency];

      Array.from(table.rows).slice(1).forEach((row) => {
        const inrCell = row.cells[inrIndex];
        const usdCell = row.cells[usdIndex];
        if (!inrCell || !usdCell || !inrCell.dataset.basePrice || !usdCell.dataset.basePrice) return;

        inrCell.hidden = !useInr;
        usdCell.hidden = useInr;
        if (useInr) {
          inrCell.textContent = inrCell.dataset.basePrice;
        } else if (selectedCurrency === "USD") {
          usdCell.textContent = usdCell.dataset.basePrice;
        } else {
          usdCell.textContent = usdCell.dataset.basePrice.replace(/\d+(?:\.\d+)?/g, (value) =>
            formatPrice(Number(value) * exchangeRates[selectedCurrency], selectedCurrency),
          );
        }
      });
    });
  };

  const formatPrice = (amount, currency) =>
    new Intl.NumberFormat("en-IN", {
      minimumFractionDigits: currency === "INR" ? 2 : 0,
      maximumFractionDigits: currency === "INR" || currency === "USD" ? 3 : 2,
    }).format(amount);

  const getUnitAmount = (product, currency = selectedCurrency) => {
    if (currency === "INR") return product.inr;
    if (product.usd === null) return null;
    return product.usd * exchangeRates[currency];
  };

  const getPriceText = (product, currency = selectedCurrency) => {
    if (currency === "INR") return product.inrText;
    if (currency === "USD") return product.usdText;
    if (product.usd !== null) {
      return formatPrice(product.usd * exchangeRates[currency], currency);
    }
    return product.usdText.replace(/\d+(?:\.\d+)?/g, (value) =>
      formatPrice(Number(value) * exchangeRates[currency], currency),
    );
  };

  const addText = (parent, tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    element.textContent = text;
    parent.append(element);
    return element;
  };

  const renderCartPage = () => {
    if (!cartItems || !cartContent || !cartEmpty) return;

    const products = Object.values(cart);
    cartItems.replaceChildren();
    cartEmpty.hidden = products.length > 0;
    cartContent.hidden = products.length === 0;

    let itemCount = 0;
    let subtotal = 0;
    let hasQuotePrice = false;

    products.forEach((product) => {
      itemCount += product.quantity;
      const unitAmount = getUnitAmount(product);
      if (unitAmount === null) {
        hasQuotePrice = true;
      } else {
        subtotal += unitAmount * product.quantity;
      }

      const item = document.createElement("article");
      item.className = "cart-item";
      const details = document.createElement("div");
      details.className = "cart-item-details";
      addText(details, "strong", "cart-sku", product.sku);
      addText(details, "p", "cart-description", product.description);
      addText(
        details,
        "p",
        "cart-unit-price",
        unitAmount === null
          ? `Unit price on request: ${currencyLabels[selectedCurrency]} ${getPriceText(product)}`
          : `Unit: ${currencyLabels[selectedCurrency]} ${formatPrice(unitAmount, selectedCurrency)}`,
      );

      const quantity = document.createElement("input");
      quantity.className = "cart-quantity cart-quantity-edit";
      quantity.type = "number";
      quantity.min = "1";
      quantity.step = "1";
      quantity.value = String(product.quantity);
      quantity.dataset.sku = product.sku;
      quantity.setAttribute("aria-label", `Quantity for ${product.sku}`);

      const totals = document.createElement("div");
      totals.className = "cart-line-total";
      if (unitAmount === null) {
        addText(totals, "strong", "", "Price confirmed in quote");
      } else {
        addText(totals, "strong", "", `${currencyLabels[selectedCurrency]} ${formatPrice(unitAmount * product.quantity, selectedCurrency)}`);
      }

      const removeButton = document.createElement("button");
      removeButton.className = "cart-remove";
      removeButton.type = "button";
      removeButton.textContent = "Remove";
      removeButton.dataset.sku = product.sku;
      removeButton.setAttribute("aria-label", `Remove ${product.sku} from cart`);

      item.append(details, quantity, totals, removeButton);
      cartItems.append(item);
    });

    const countElement = document.getElementById("cartCount");
    const summaryCountElement = document.getElementById("cartCountSummary");
    const subtotalElement = document.getElementById("cartSubtotal");
    const subtotalLabel = document.getElementById("cartSubtotalLabel");
    const noteElement = document.getElementById("cartSummaryNote");
    if (countElement) countElement.textContent = String(itemCount);
    if (summaryCountElement) summaryCountElement.textContent = String(itemCount);
    if (subtotalElement) subtotalElement.textContent = `${currencyLabels[selectedCurrency]} ${formatPrice(subtotal, selectedCurrency)}`;
    if (subtotalLabel) subtotalLabel.textContent = `${selectedCurrency} subtotal`;
    if (noteElement) {
      const conversionNote = selectedCurrency === "INR" || selectedCurrency === "USD"
        ? ""
        : " Currency conversion is indicative; final pricing is confirmed in your quote.";
      noteElement.textContent = hasQuotePrice
        ? `Subtotal covers fixed-price items only. Range-priced items and shipping are confirmed with your BrannEco quote.${conversionNote}`
        : `Shipping, taxes and final pricing are confirmed with your BrannEco quote.${conversionNote}`;
    }

    const clearButton = document.getElementById("cartClear");
    if (clearButton) clearButton.disabled = products.length === 0;

    const quoteButton = document.getElementById("quoteButton");
    if (quoteButton) {
      const orderLines = products.map(
        (product) => `${product.sku} - ${product.description} x ${product.quantity} (${currencyLabels[selectedCurrency]} ${getPriceText(product)})`,
      );
      const body = ["Hi BrannEco,", "", "Please quote the following order:", ...orderLines, "", `${selectedCurrency} subtotal: ${currencyLabels[selectedCurrency]} ${formatPrice(subtotal, selectedCurrency)}`].join("\n");
      quoteButton.href = `mailto:ritiknitw7697@gmail.com?subject=${encodeURIComponent("BrannEco Order Quote")}&body=${encodeURIComponent(body)}`;
    }
  };

  document.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;

    const link = event.target.closest("a[href]");
    if (link && !link.hasAttribute("download")) {
      const href = link.getAttribute("href");
      const targetUrl = new URL(link.href, location.href);
      const directory = location.pathname.slice(0, location.pathname.lastIndexOf("/") + 1);
      const pagesIndex = location.pathname.indexOf("/pages/");
      const appDirectory = pagesIndex < 0
        ? directory
        : location.pathname.slice(0, pagesIndex + 1);
      if (
        isLocalFile &&
        href &&
        !href.startsWith("#") &&
        targetUrl.protocol === "file:" &&
        targetUrl.pathname.startsWith(appDirectory) &&
        targetUrl.pathname.endsWith(".html") &&
        (targetUrl.pathname !== location.pathname || targetUrl.hash !== location.hash)
      ) {
        link.href = buildNavigationUrl(targetUrl.href);
      }
    }

    const addButton = event.target.closest(".addrow");
    if (addButton) {
      const quantityInput = addButton.parentElement.querySelector(".cart-quantity");
      const quantity = Math.floor(Number(quantityInput?.value));
      if (!Number.isFinite(quantity) || quantity < 1) return;

      const sku = addButton.dataset.sku;
      const product = cart[sku] || {
        sku,
        description: addButton.dataset.description,
        inr: addButton.dataset.inr ? Number(addButton.dataset.inr) : null,
        usd: addButton.dataset.usd ? Number(addButton.dataset.usd) : null,
        inrText: addButton.dataset.inrText,
        usdText: addButton.dataset.usdText,
        quantity: 0,
      };
      product.quantity += quantity;
      cart[sku] = product;
      saveCart();
      showToast();
      return;
    }

    const removeButton = event.target.closest(".cart-remove");
    if (removeButton) {
      delete cart[removeButton.dataset.sku];
      saveCart();
    }
  });

  cartItems?.addEventListener("change", (event) => {
    if (!(event.target instanceof HTMLInputElement)) return;
    const input = event.target.closest(".cart-quantity-edit");
    if (!input) return;

    const quantity = Math.floor(Number(input.value));
    if (!Number.isFinite(quantity) || quantity < 1) {
      input.value = "1";
      cart[input.dataset.sku].quantity = 1;
    } else {
      cart[input.dataset.sku].quantity = quantity;
    }
    saveCart();
  });

  document.getElementById("cartClear")?.addEventListener("click", () => {
    cart = {};
    saveCart();
  });

  if (cartButton && !cartItems && cartButton.tagName === "BUTTON") {
    cartButton.addEventListener("click", () => {
      const cartPage = location.pathname.includes("/pages/") ? "cart.html" : "pages/cart.html";
      window.location.href = buildNavigationUrl(cartPage);
    });
  }

  setupCatalogTables();
  applySelectedCurrency();
  updateCartButton();
  renderCartPage();
})();