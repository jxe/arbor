() => {
  try { window.__arborEditorAudit?.cleanup?.(); } catch {}

  const themeAttribute = "data-arbor-audit-theme";
  const originalTheme = document.documentElement.getAttribute(themeAttribute);
  const overlayID = "arbor-editor-audit-overlay";

  const rounded = (value) => Math.round(value * 100) / 100;
  const visible = (element) => {
    if (!element) return false;
    const style = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && bounds.width > 0 && bounds.height > 0;
  };
  const measurement = (element) => {
    if (!element) return null;
    const style = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    return {
      tag: element.tagName.toLowerCase(),
      type: element.dataset.contentType ?? null,
      level: element.dataset.level
        ?? (element.dataset.contentType === "heading" && element.querySelector?.(":scope > h1") ? "1" : null),
      x: rounded(bounds.x),
      y: rounded(bounds.y),
      width: rounded(bounds.width),
      height: rounded(bounds.height),
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      lineHeight: style.lineHeight,
      padding: style.padding,
      margin: style.margin,
      color: style.color,
      background: style.backgroundColor,
    };
  };
  const queryMeasurement = (selector) => measurement(document.querySelector(selector));
  const topLevelBlocks = () => [
    ...document.querySelectorAll(".bn-editor > .bn-block-group > .bn-block-outer"),
  ];

  const report = () => {
    const rootStyle = getComputedStyle(document.documentElement);
    const blocks = topLevelBlocks().slice(0, 40).map((outer, index, items) => {
      const content = outer.querySelector(":scope > .bn-block > .bn-block-content");
      const bounds = outer.getBoundingClientRect();
      const previousBounds = index > 0 ? items[index - 1].getBoundingClientRect() : null;
      return {
        index,
        type: content?.getAttribute("data-content-type") ?? null,
        level: content?.getAttribute("data-level") ?? (content?.querySelector("h1") ? "1" : null),
        top: rounded(bounds.top),
        height: rounded(bounds.height),
        gapBefore: previousBounds ? rounded(bounds.top - previousBounds.bottom) : null,
        content: measurement(content),
      };
    });
    const nestedGroup = document.querySelector(".bn-block-group .bn-block-group");
    const sidebar = document.querySelector(".workspace-sidebar");
    const properties = document.querySelector(".properties");
    const editor = document.querySelector(".bn-editor");
    return {
      generatedAt: new Date().toISOString(),
      theme: {
        mantine: document.documentElement.getAttribute("data-mantine-color-scheme"),
        forced: document.documentElement.getAttribute(themeAttribute),
        foreground: rootStyle.getPropertyValue("--arbor-foreground").trim(),
        background: rootStyle.getPropertyValue("--arbor-background").trim(),
        sidebar: rootStyle.getPropertyValue("--arbor-sidebar").trim(),
        link: rootStyle.getPropertyValue("--arbor-link").trim(),
        selection: rootStyle.getPropertyValue("--arbor-selection").trim(),
      },
      fonts: {
        status: document.fonts.status,
        inter400: document.fonts.check('400 16px "Inter"'),
        inter600: document.fonts.check('600 40px "Inter"'),
      },
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        documentWidth: document.documentElement.scrollWidth,
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      },
      shell: queryMeasurement(".editor-shell"),
      editor: measurement(editor),
      title: queryMeasurement(
        '.bn-editor > .bn-block-group > .bn-block-outer:first-child > .bn-block > .bn-block-content[data-content-type="heading"]:not([data-level])',
      ),
      headings: {
        h1: queryMeasurement('.bn-block-content[data-content-type="heading"]:not([data-level])'),
        h2: queryMeasurement('.bn-block-content[data-content-type="heading"][data-level="2"]'),
        h3: queryMeasurement('.bn-block-content[data-content-type="heading"][data-level="3"]'),
      },
      nestedIndent: nestedGroup ? getComputedStyle(nestedGroup).marginLeft : null,
      blocks,
      controls: {
        sidebarVisible: visible(sidebar),
        sidebarCollapsed: document.querySelector(".app")?.classList.contains("sidebar-collapsed") ?? false,
        propertiesVisible: visible(properties),
        propertiesOpen: properties ? Boolean(properties.open) : null,
        pageMenuVisible: visible(document.querySelector(".page-actions-menu")),
        persistentBottomActions: visible(document.querySelector(".editor-actions")),
        statusText: document.querySelector('[role="status"]')?.textContent?.trim() ?? null,
      },
    };
  };

  const cleanupOverlay = () => document.getElementById(overlayID)?.remove();
  const overlay = () => {
    cleanupOverlay();
    const layer = document.createElement("div");
    layer.id = overlayID;
    layer.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;font:11px/1.2 ui-monospace,monospace;color:#ff4f87";

    const outline = (element, label, color = "#ff4f87") => {
      if (!element || !visible(element)) return;
      const bounds = element.getBoundingClientRect();
      const box = document.createElement("div");
      box.style.cssText = `position:fixed;left:${bounds.left}px;top:${bounds.top}px;width:${bounds.width}px;height:${bounds.height}px;border:1px solid ${color};background:transparent`;
      const caption = document.createElement("span");
      caption.textContent = label;
      caption.style.cssText = `position:absolute;left:0;top:-15px;padding:1px 3px;border-radius:2px;background:${color};color:#fff;white-space:nowrap`;
      box.append(caption);
      layer.append(box);
    };

    outline(document.querySelector(".editor-shell"), "708px page column", "#ff4f87");
    outline(document.querySelector(".bn-editor"), "BlockNote editor", "#2383e2");
    outline(document.querySelector(".properties"), "properties disclosure", "#a56de2");
    topLevelBlocks().slice(0, 30).forEach((block, index) => {
      const content = block.querySelector(":scope > .bn-block > .bn-block-content");
      outline(block, `${index}: ${content?.getAttribute("data-content-type") ?? "block"}`, "#f2994a");
    });
    document.body.append(layer);
    return report();
  };

  const setTheme = (theme) => {
    if (theme === "light" || theme === "dark") {
      document.documentElement.setAttribute(themeAttribute, theme);
    } else if (originalTheme === null) {
      document.documentElement.removeAttribute(themeAttribute);
    } else {
      document.documentElement.setAttribute(themeAttribute, originalTheme);
    }
    return report();
  };

  const cleanup = () => {
    cleanupOverlay();
    if (originalTheme === null) document.documentElement.removeAttribute(themeAttribute);
    else document.documentElement.setAttribute(themeAttribute, originalTheme);
    delete window.__arborEditorAudit;
  };

  try {
    window.__arborEditorAudit = { report, overlay, setTheme, cleanup };
  } catch {
    // Codex's built-in browser exposes a read-only page wrapper. The initial
    // report still works there; writable page contexts also retain the API.
  }
  return report();
}
