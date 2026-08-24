/**
 * Context Menu Manager for MOSA
 * Handles right-click menus for navigation and asset library
 */

export function createContextMenu() {
  let currentMenu = null;
  let currentTarget = null;

  /**
   * Create and show a context menu
   * @param {Object} options - Menu configuration
   * @param {Array} options.items - Menu items
   * @param {number} options.x - X position
   * @param {number} options.y - Y position
   * @param {HTMLElement} options.target - Target element
   * @param {Function} options.onClose - Close callback
   */
  function show({ items, x, y, target, onClose }) {
    hide();

    const menu = document.createElement("div");
    menu.className = "context-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("tabindex", "-1");

    items.forEach((item, index) => {
      if (item.separator) {
        const separator = document.createElement("div");
        separator.className = "context-menu-separator";
        separator.setAttribute("role", "separator");
        menu.appendChild(separator);
        return;
      }

      const menuItem = document.createElement("button");
      menuItem.className = "context-menu-item";
      menuItem.type = "button";
      menuItem.setAttribute("role", "menuitem");
      menuItem.dataset.index = String(index);

      if (item.disabled) {
        menuItem.disabled = true;
        menuItem.classList.add("disabled");
      }

      if (item.danger) {
        menuItem.classList.add("danger");
      }

      if (item.icon) {
        const icon = document.createElement("span");
        icon.className = "context-menu-icon";
        icon.innerHTML = item.icon;
        menuItem.appendChild(icon);
      }

      const label = document.createElement("span");
      label.className = "context-menu-label";
      label.textContent = item.label;
      menuItem.appendChild(label);

      if (item.shortcut) {
        const shortcut = document.createElement("span");
        shortcut.className = "context-menu-shortcut";
        shortcut.textContent = item.shortcut;
        menuItem.appendChild(shortcut);
      }

      if (item.submenu) {
        const arrow = document.createElement("span");
        arrow.className = "context-menu-arrow";
        arrow.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg>';
        menuItem.appendChild(arrow);
        menuItem.classList.add("has-submenu");
      }

      if (!item.disabled) {
        menuItem.addEventListener("click", async (e) => {
          e.stopPropagation();
          if (item.submenu) {
            showSubmenu(menuItem, item.submenu);
          } else if (item.action) {
            hide();
            await item.action();
          }
        });

        if (item.submenu) {
          menuItem.addEventListener("mouseenter", () => {
            showSubmenu(menuItem, item.submenu);
          });
        }
      }

      menu.appendChild(menuItem);
    });

    document.body.appendChild(menu);
    currentMenu = menu;
    currentTarget = target;

    // Position the menu
    positionMenu(menu, x, y);

    // Focus the first enabled item
    requestAnimationFrame(() => {
      const firstItem = menu.querySelector(".context-menu-item:not(.disabled)");
      firstItem?.focus();
    });

    // Setup event listeners
    const closeHandler = (e) => {
      if (!menu.contains(e.target)) {
        hide();
      }
    };

    const keyHandler = (e) => {
      handleKeyDown(e, menu);
    };

    setTimeout(() => {
      document.addEventListener("click", closeHandler);
      document.addEventListener("contextmenu", closeHandler);
      document.addEventListener("keydown", keyHandler);
    }, 0);

    menu._cleanup = () => {
      document.removeEventListener("click", closeHandler);
      document.removeEventListener("contextmenu", closeHandler);
      document.removeEventListener("keydown", keyHandler);
      if (onClose) onClose();
    };
  }

  function showSubmenu(parentItem, items) {
    // Remove existing submenus
    document.querySelectorAll(".context-menu-submenu").forEach((sub) => sub.remove());

    const submenu = document.createElement("div");
    submenu.className = "context-menu context-menu-submenu";
    submenu.setAttribute("role", "menu");

    items.forEach((item) => {
      if (item.separator) {
        const separator = document.createElement("div");
        separator.className = "context-menu-separator";
        separator.setAttribute("role", "separator");
        submenu.appendChild(separator);
        return;
      }

      const menuItem = document.createElement("button");
      menuItem.className = "context-menu-item";
      menuItem.type = "button";
      menuItem.setAttribute("role", "menuitem");

      if (item.disabled) {
        menuItem.disabled = true;
        menuItem.classList.add("disabled");
      }

      if (item.danger) {
        menuItem.classList.add("danger");
      }

      if (item.icon) {
        const icon = document.createElement("span");
        icon.className = "context-menu-icon";
        icon.innerHTML = item.icon;
        menuItem.appendChild(icon);
      }

      const label = document.createElement("span");
      label.className = "context-menu-label";
      label.textContent = item.label;
      menuItem.appendChild(label);

      if (!item.disabled && item.action) {
        menuItem.addEventListener("click", async (e) => {
          e.stopPropagation();
          hide();
          await item.action();
        });
      }

      submenu.appendChild(menuItem);
    });

    document.body.appendChild(submenu);

    // Position submenu next to parent item
    const rect = parentItem.getBoundingClientRect();
    const x = rect.right;
    const y = rect.top;
    positionMenu(submenu, x, y);
  }

  function positionMenu(menu, x, y) {
    const rect = menu.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let finalX = x;
    let finalY = y;

    // Adjust horizontal position if menu overflows right edge
    if (x + rect.width > viewportWidth) {
      finalX = Math.max(8, viewportWidth - rect.width - 8);
    }

    // Adjust vertical position if menu overflows bottom edge
    if (y + rect.height > viewportHeight) {
      finalY = Math.max(8, viewportHeight - rect.height - 8);
    }

    menu.style.left = `${finalX}px`;
    menu.style.top = `${finalY}px`;
  }

  function handleKeyDown(e, menu) {
    const items = Array.from(menu.querySelectorAll(".context-menu-item:not(.disabled)"));
    const currentIndex = items.findIndex((item) => item === document.activeElement);

    switch (e.key) {
      case "Escape":
        e.preventDefault();
        hide();
        break;
      case "ArrowDown":
        e.preventDefault();
        if (currentIndex < items.length - 1) {
          items[currentIndex + 1]?.focus();
        } else {
          items[0]?.focus();
        }
        break;
      case "ArrowUp":
        e.preventDefault();
        if (currentIndex > 0) {
          items[currentIndex - 1]?.focus();
        } else {
          items[items.length - 1]?.focus();
        }
        break;
      case "ArrowRight":
        if (document.activeElement?.classList.contains("has-submenu")) {
          e.preventDefault();
          const submenu = document.querySelector(".context-menu-submenu");
          submenu?.querySelector(".context-menu-item:not(.disabled)")?.focus();
        }
        break;
      case "ArrowLeft":
        if (menu.classList.contains("context-menu-submenu")) {
          e.preventDefault();
          hide();
          currentMenu?.querySelector(".context-menu-item:focus, .context-menu-item.has-submenu")?.focus();
        }
        break;
    }
  }

  function hide() {
    document.querySelectorAll(".context-menu").forEach((menu) => {
      if (menu._cleanup) menu._cleanup();
      menu.remove();
    });
    currentMenu = null;
    currentTarget = null;
  }

  return { show, hide };
}
