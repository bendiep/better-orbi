/* Include offline clients supplied by the router in Basic and Advanced.
   Runs in the page's MAIN world to access the firmware's Vue 2 component. */
(() => {
  "use strict";

  const tableSelector = "#app .orbi .attached-form #device_table.el-table";
  const patched = new WeakSet();
  let pendingFrame = null;
  const mac = value => (value ?? "").replace(/[:-]/g, "").trim().toLowerCase();
  const isOffline = device => device.alive === 0 || device.alive === false || device.alive === "0";

  function clientDevices() {
    const devices = [];
    const isOrbi = this.$store.state.page.type === "orbi";

    for (const device of this.info.devices) {
      // Keep the firmware's other filters and MAC-to-edit-index mapping.
      if (device.conn_type === "vpn" || (isOrbi && device.attached_type === "satellite")) continue;
      const entry = this.info.devices_list.find(item => item.mac_addr === device.mac_addr);
      if (entry) devices.push(Object.assign({ index: entry.index }, device));
    }

    return devices;
  }

  function markOfflineRows(table, devices) {
    const offlineMacs = new Set(devices.filter(isOffline).map(device => mac(device.mac_addr)));
    offlineMacs.delete("");

    // Match by MAC, since the sorting script can move rows into a different order.
    for (const row of table.querySelectorAll(".el-table__body-wrapper tbody tr")) {
      const connection = row.querySelector(".conn-type")?.closest(".cell");
      if (!connection) continue;
      const offline = [...row.cells].some(cell => offlineMacs.has(mac(cell.textContent)));
      const badge = row.querySelector(".orbi-device-offline-label");
      row.classList.toggle("orbi-device-offline", offline);
      if (offline && !badge) {
        const label = document.createElement("span");
        label.className = "orbi-device-offline-label";
        label.textContent = "Offline";
        connection.appendChild(label);
      } else if (offline && badge.parentElement !== connection) {
        connection.appendChild(badge);
      } else if (!offline && badge) {
        badge.remove();
      }
    }
  }

  function reconcile() {
    const table = document.querySelector(tableSelector);
    // Element UI owns the table; its ancestor owns the device data and editor.
    for (let component = table?.__vue__; component; component = component.$parent) {
      const watcher = component._computedWatchers?.clientDevices;
      if (typeof watcher?.getter !== "function"
        || !Array.isArray(component.info?.devices)
        || !Array.isArray(component.info?.devices_list)) continue;

      if (!patched.has(component)) {
        // Replace only this instance's cached computed getter. Vue continues to
        // track its dependencies, so refreshes and device editing use the same list.
        watcher.getter = clientDevices;
        watcher.dirty = true;
        patched.add(component);
        // A status-only change may leave the rendered cells unchanged.
        component.$watch("clientDevices", () => component.$nextTick(schedule));
        component.$forceUpdate();
      }
      markOfflineRows(table, component.clientDevices);
      return;
    }
  }

  function schedule() {
    if (pendingFrame !== null) return;
    pendingFrame = requestAnimationFrame(() => {
      pendingFrame = null;
      reconcile();
    });
  }

  // Discover newly mounted components after navigation or closing an editor.
  const observer = new MutationObserver(schedule);
  observer.observe(document, { childList: true, subtree: true });
  schedule();
})();
