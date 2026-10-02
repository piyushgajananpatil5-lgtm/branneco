(() => {
  const minimumOrderQuantity = 500;
  const exchangeRates = { USD: 1, EUR: 0.92, GBP: 0.79, AED: 3.67 };
  const currencySymbols = { INR: "₹", USD: "US$", EUR: "€", GBP: "£", AED: "AED " };
  const formatAmount = (amount, currency) =>
    new Intl.NumberFormat("en-IN", {
      minimumFractionDigits: currency === "INR" || currency === "USD" ? 2 : 0,
      maximumFractionDigits: currency === "INR" ? 2 : currency === "USD" ? 3 : 2,
    }).format(amount);

  const updateProductPrices = (currency) => {
    document.querySelectorAll(".catsec").forEach((section) => {
      const table = section.querySelector(".hidden-data table");
      if (!table) return;

      const inrIndex = Number(table.dataset.inrIndex);
      const usdIndex = Number(table.dataset.usdIndex);
      const pricesBySku = new Map();
      Array.from(table.rows).slice(1).forEach((row) => {
        pricesBySku.set(row.cells[0].textContent.trim(), {
          inr: row.cells[inrIndex].dataset.basePrice,
          usd: row.cells[usdIndex].dataset.basePrice,
        });
      });

      section.querySelectorAll(".variant-select option[data-sku]").forEach((option) => {
        const prices = pricesBySku.get(option.dataset.sku);
        if (!prices) return;
        if (!option.dataset.productLabel) option.dataset.productLabel = option.textContent.trim();

        const sourcePrice = currency === "INR" ? prices.inr : prices.usd;
        const multiplier = currency === "INR" ? 1 : exchangeRates[currency];
        const price = sourcePrice.replace(/\d+(?:\.\d+)?/g, (amount) =>
          formatAmount(Number(amount) * multiplier, currency),
        );
        option.textContent = `${option.dataset.productLabel} · ${currencySymbols[currency]}${price}`;
      });
    });
  };

  updateProductPrices(document.documentElement.dataset.currency || "INR");
  document.addEventListener("branneco:catalogupdated", () => {
    updateProductPrices(document.documentElement.dataset.currency || "INR");
  });

  document.querySelectorAll(".catsec").forEach((section) => {
    const addButton = section.querySelector(".quick-add-btn");
    const quantityInput = section.querySelector(".qty-input");
    const select = section.querySelector(".variant-select");
    if (!addButton || !quantityInput || !select) return;

    addButton.addEventListener("click", () => {
      const option = select.options[select.selectedIndex];
      const sku = option?.dataset.sku;
      if (!sku) {
        select.focus();
        return;
      }

      const skuCell = Array.from(section.querySelectorAll("td.sku")).find(
        (cell) => cell.textContent.trim() === sku,
      );
      const rowButton = skuCell?.closest("tr")?.querySelector(".addrow");
      if (!rowButton) return;

      const quantity = Math.max(1, parseInt(quantityInput.value, 10) || 1);
      if (quantity < minimumOrderQuantity) {
        if (window.brannEcoShowMoqDialog) window.brannEcoShowMoqDialog(quantityInput);
        else window.alert(`Minimum order is ${minimumOrderQuantity} units per product.`);
        quantityInput.focus();
        return;
      }

      const rowQuantityInput = rowButton.parentElement.querySelector(".cart-quantity");
      rowQuantityInput.value = String(quantity);
      rowButton.click();
    });
  });
})();
