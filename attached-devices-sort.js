/* Local sorting for the Connected Devices table in Basic and Advanced.
   Move existing rows so the router's device-edit handlers stay attached. */
(() => {
  "use strict";

  const tableSelector = "#app .orbi .attached-form #device_table.el-table";
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const originalOrder = new WeakMap();
  let nextOrder = 0;
  let activeSort = null;
  let pendingFrame = null;

  const clean = value => (value ?? "").replace(/\s+/g, " ").trim();
  const text = element => clean(element?.textContent);
  const mac = value => clean(value).replace(/[:-]/g, "").toLowerCase();

  function ipv4(value) {
    if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return null;
    const parts = value.split(".").map(Number);
    return parts.every(part => part <= 255) ? parts : null;
  }

  function columnKind(cell, index, count) {
    if (index === 0) return "number";
    if (cell?.querySelector(".device-name")) return "name";
    if (cell?.querySelector(".device-conn")) return "orbi";
    if (cell?.querySelector(".conn-type")) return "connection";
    if (ipv4(text(cell))) return "ip";
    if (/^(?:[\da-f]{2}[:-]){5}[\da-f]{2}$/i.test(text(cell))) return "mac";

    // The firmware can insert an access-control Status column after #.
    const schema = count === 7
      ? ["number", "text", "name", "ip", "mac", "connection", "orbi"]
      : ["number", "name", "ip", "mac", "connection", "orbi"];
    return schema[index] ?? "text";
  }

  function values(cell, kind) {
    if (kind === "name") {
      const spans = cell?.querySelectorAll(".device-name > span");
      const model = text(spans?.[0]);
      return [text(spans?.[1]) || model, model];
    }
    if (kind === "orbi") {
      const spans = cell?.querySelectorAll(".device-conn > span");
      return [text(spans?.[0]) || text(cell), mac(text(spans?.[1]))];
    }
    // The first .conn-type contains only an image; the label is in its sibling.
    if (kind === "connection") return [text(cell)];
    if (kind === "mac") return [mac(text(cell))];
    return [text(cell)];
  }

  function compareValue(a, b, kind) {
    if (kind === "number") {
      const left = Number(a);
      const right = Number(b);
      if (Number.isFinite(left) && Number.isFinite(right)) return left - right;
    }
    if (kind === "ip") {
      const left = ipv4(a);
      const right = ipv4(b);
      if (left && right) {
        for (let i = 0; i < 4; i += 1) {
          if (left[i] !== right[i]) return left[i] - right[i];
        }
        return 0;
      }
    }
    if (kind === "mac") return a === b ? 0 : a < b ? -1 : 1;
    return collator.compare(a, b);
  }

  function makeHeaderButton(header) {
    const cell = header.querySelector(".cell");
    if (!cell) return null;
    let button = cell.querySelector(":scope > .orbi-sort-header");

    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "orbi-sort-header";
      const label = document.createElement("span");
      label.className = "orbi-sort-label";
      // Keep Vue's original label nodes alive, including translated labels.
      while (cell.firstChild) label.appendChild(cell.firstChild);
      const indicator = document.createElement("span");
      indicator.className = "orbi-sort-indicator";
      indicator.setAttribute("aria-hidden", "true");
      button.append(label, indicator);
      cell.appendChild(button);
    } else {
      // Vue may write a fresh label alongside our button during a render.
      const freshLabel = [...cell.childNodes].filter(node => node !== button
        && (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.ELEMENT_NODE)
        && text(node));
      if (freshLabel.length) {
        button.querySelector(".orbi-sort-label").replaceChildren(...freshLabel);
      }
    }
    return button;
  }

  function readColumns(table, rows) {
    const headers = [...table.querySelectorAll(".el-table__header-wrapper thead th")];
    return headers.map((header, index) => {
      const button = makeHeaderButton(header);
      if (!button) return null;
      const label = text(button.querySelector(".orbi-sort-label"));
      const kind = columnKind(rows[0]?.cells[index], index, headers.length);
      const key = kind === "text" ? `text:${label}` : kind;
      header.dataset.orbiSortKey = key;
      return { header, button, label, key, kind, index };
    }).filter(Boolean);
  }

  function updateIndicators(columns) {
    for (const column of columns) {
      const selected = activeSort?.key === column.key;
      const direction = selected ? activeSort.direction : null;
      column.header.setAttribute("aria-sort", direction === 1
        ? "ascending" : direction === -1 ? "descending" : "none");
      const nextDirection = direction === 1 ? "descending" : "ascending";
      column.button.setAttribute("aria-label", `Sort ${column.label} ${nextDirection}`);
      column.button.title = `Sort ${column.label} ${nextDirection}`;
      const indicator = column.button.querySelector(".orbi-sort-indicator");
      const symbol = direction === 1 ? "↑" : direction === -1 ? "↓" : "↕";
      if (indicator.textContent !== symbol) indicator.textContent = symbol;
    }
  }

  function sortRows(body, rows, column) {
    const records = rows.map(row => {
      if (!originalOrder.has(row)) originalOrder.set(row, nextOrder++);
      const number = Number(text(row.cells[0]));
      return {
        row,
        values: values(row.cells[column.index], column.kind),
        order: Number.isFinite(number) && number > 0 ? number : originalOrder.get(row)
      };
    });

    records.sort((left, right) => {
      const a = left.values;
      const b = right.values;
      // Missing values stay at the end in either direction.
      if (!a[0] && b[0]) return 1;
      if (a[0] && !b[0]) return -1;
      for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
        const kind = i === 0 ? column.kind : column.kind === "orbi" ? "mac" : "text";
        const difference = compareValue(a[i] ?? "", b[i] ?? "", kind);
        if (difference) return difference * activeSort.direction;
      }
      return left.order - right.order;
    });

    if (records.every((record, index) => record.row === rows[index])) return;
    const fragment = document.createDocumentFragment();
    for (const record of records) fragment.appendChild(record.row);
    body.appendChild(fragment);
  }

  function reconcile() {
    // Avoid responding to our own header and row mutations.
    observer.disconnect();
    try {
      const table = document.querySelector(tableSelector);
      if (!table) return;
      const body = table.querySelector(".el-table__body-wrapper tbody");
      const rows = body ? [...body.rows].filter(row => row.cells.length) : [];
      const columns = readColumns(table, rows);
      const column = columns.find(item => item.key === activeSort?.key);
      table.dataset.orbiSorted = column ? "true" : "false";
      updateIndicators(columns);
      if (body && column && rows.length > 1) sortRows(body, rows, column);
    } finally {
      observer.observe(document, { childList: true, characterData: true, subtree: true });
    }
  }

  function schedule() {
    if (pendingFrame !== null) return;
    pendingFrame = requestAnimationFrame(() => {
      pendingFrame = null;
      reconcile();
    });
  }

  const observer = new MutationObserver(schedule);

  // Delegation also covers headers recreated during refresh or route changes.
  document.addEventListener("click", event => {
    const header = event.target instanceof Element
      ? event.target.closest("th[data-orbi-sort-key]") : null;
    if (!header?.closest(tableSelector)) return;
    event.preventDefault();
    event.stopPropagation();
    const key = header.dataset.orbiSortKey;
    activeSort = {
      key,
      direction: activeSort?.key === key ? -activeSort.direction : 1
    };
    reconcile();
  }, true);

  observer.observe(document, { childList: true, characterData: true, subtree: true });
  schedule();
})();
