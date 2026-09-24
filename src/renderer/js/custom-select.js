// 自定义下拉菜单组件 - 替换原生select，搜索过滤需 data-search="true" 按需启用
(function() {
  'use strict';

  const styleEl = document.createElement('style');
  styleEl.textContent = '.custom-select-options::-webkit-scrollbar{width:6px}.custom-select-options::-webkit-scrollbar-track{background:transparent}.custom-select-options::-webkit-scrollbar-thumb{background:#3a3a48;border-radius:3px}.custom-select-options::-webkit-scrollbar-thumb:hover{background:#4a4a58}.custom-select-search::placeholder{color:#555}.custom-select-search:focus{outline:none!important;border:none!important;box-shadow:none!important;background:transparent!important}';
  document.head.appendChild(styleEl);

  function convertSelect(originalSelect) {
    if (!originalSelect || originalSelect.tagName !== 'SELECT') return;
    if (originalSelect.dataset.customSelectConverted) return;
    originalSelect.dataset.customSelectConverted = 'true';

    const hasSearch = originalSelect.dataset.search === 'true';

    const wrapper = document.createElement('div');
    wrapper.className = 'custom-select-wrapper';
    wrapper.style.cssText = 'position:relative;display:inline-block;width:auto;min-width:80px;border:none;background:transparent;padding:0;margin:0;';

    const display = document.createElement('div');
    display.className = 'custom-select-display';
    display.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:6px 12px;background:transparent;border:1px solid var(--border-color,#444);border-radius:6px;cursor:pointer;user-select:none;width:100%;box-sizing:border-box;font-size:13px;color:var(--text-primary,#fff);transition:border-color 0.2s;min-height:32px;';

    const textSpan = document.createElement('span');
    textSpan.className = 'custom-select-text';
    textSpan.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';

    const arrow = document.createElement('span');
    arrow.className = 'custom-select-arrow';
    arrow.innerHTML = '▼';
    arrow.style.cssText = 'margin-left:8px;font-size:10px;color:var(--text-secondary,#999);transition:transform 0.2s;flex-shrink:0;';

    display.appendChild(textSpan);
    display.appendChild(arrow);

    const dropdown = document.createElement('div');
    dropdown.className = 'custom-select-dropdown';
    // 带搜索的下拉给最小宽度220px（长选项需要），不带搜索的和选择器同宽
    dropdown.style.cssText = hasSearch
      ? 'position:absolute;top:100%;left:0;right:0;margin-top:4px;background:#1a1a24;border:1px solid #3a3a48;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.5);z-index:10000;display:none;overflow:hidden;min-width:220px;'
      : 'position:absolute;top:100%;left:0;right:0;margin-top:4px;background:#1a1a24;border:1px solid #3a3a48;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,0.5);z-index:10000;display:none;overflow:hidden;';

    let searchInput = null;
    if (hasSearch) {
      const searchWrap = document.createElement('div');
      searchWrap.style.cssText = 'display:flex;align-items:center;padding:0 12px;background:#1a1a24;border-bottom:1px solid #2a2a38;';
      const searchIcon = document.createElement('span');
      searchIcon.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#666" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>';
      searchIcon.style.cssText = 'flex-shrink:0;margin-right:8px;display:inline-flex;';
      searchInput = document.createElement('input');
      searchInput.type = 'text';
      searchInput.placeholder = '搜索...';
      searchInput.className = 'custom-select-search';
      searchInput.style.cssText = 'flex:1;box-sizing:border-box;padding:10px 0;background:transparent;border:none;color:#e0e0e0;font-size:13px;outline:none;caret-color:#ff5252;';
      searchWrap.appendChild(searchIcon);
      searchWrap.appendChild(searchInput);
      dropdown.appendChild(searchWrap);
    }

    const optionsContainer = document.createElement('div');
    optionsContainer.className = 'custom-select-options';
    optionsContainer.style.cssText = 'max-height:240px;overflow-y:auto;scrollbar-width:thin;scrollbar-color:#3a3a48 transparent;';
    dropdown.appendChild(optionsContainer);
    wrapper.appendChild(display);
    wrapper.appendChild(dropdown);

    originalSelect.style.position = 'absolute';
    originalSelect.style.opacity = '0';
    originalSelect.style.pointerEvents = 'none';
    originalSelect.style.width = '0';
    originalSelect.style.height = '0';
    originalSelect.parentNode.insertBefore(wrapper, originalSelect);
    wrapper.appendChild(originalSelect);

    function updateDisplay() {
      const selectedOption = originalSelect.options[originalSelect.selectedIndex];
      if (selectedOption) {
        textSpan.textContent = selectedOption.textContent;
        textSpan.dataset.value = selectedOption.value;
      } else {
        textSpan.textContent = '';
      }
    }

    function renderOptions(filter) {
      optionsContainer.innerHTML = '';
      const keyword = hasSearch && filter ? filter.toLowerCase().trim() : '';
      let hasVisible = false;

      Array.from(originalSelect.options).forEach((option, index) => {
        const text = option.textContent;
        if (keyword && !text.toLowerCase().includes(keyword)) return;
        hasVisible = true;

        const item = document.createElement('div');
        item.className = 'custom-select-option';
        item.dataset.value = option.value;
        item.dataset.index = index;
        item.textContent = text;
        item.style.cssText = 'padding:9px 14px;cursor:pointer;font-size:13px;color:#c8c8d0;transition:background 0.15s,color 0.15s;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        if (index === originalSelect.selectedIndex) {
          item.style.background = 'rgba(255,82,82,0.15)';
          item.style.color = '#ff5252';
          item.style.fontWeight = '600';
        }
        item.addEventListener('mouseenter', () => {
          if (index !== originalSelect.selectedIndex) { item.style.background = '#252532'; item.style.color = '#fff'; }
        });
        item.addEventListener('mouseleave', () => {
          if (index !== originalSelect.selectedIndex) { item.style.background = 'transparent'; item.style.color = '#c8c8d0'; }
        });
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          originalSelect.selectedIndex = index;
          originalSelect.dispatchEvent(new Event('change', { bubbles: true }));
          updateDisplay();
          if (searchInput) searchInput.value = '';
          closeDropdown();
        });
        optionsContainer.appendChild(item);
      });

      if (!hasVisible) {
        const empty = document.createElement('div');
        empty.style.cssText = 'padding:12px;color:var(--text-secondary,#999);font-size:13px;text-align:center;';
        empty.textContent = '无匹配项';
        optionsContainer.appendChild(empty);
      }
    }

    function openDropdown() {
      dropdown.style.display = 'block';
      arrow.style.transform = 'rotate(180deg)';
      display.style.borderColor = '#ff5252';
      if (searchInput) {
        searchInput.value = '';
        setTimeout(() => searchInput.focus(), 50);
      }
      renderOptions();
      const selectedItem = optionsContainer.querySelector('.custom-select-option[data-index="' + originalSelect.selectedIndex + '"]');
      if (selectedItem) selectedItem.scrollIntoView({ block: 'nearest' });
    }

    function closeDropdown() {
      dropdown.style.display = 'none';
      arrow.style.transform = 'rotate(0deg)';
      display.style.borderColor = '#3a3a48';
    }

    function toggleDropdown(e) {
      e.stopPropagation();
      if (dropdown.style.display === 'block') {
        closeDropdown();
      } else {
        document.querySelectorAll('.custom-select-dropdown').forEach(d => {
          d.style.display = 'none';
          d.previousElementSibling.querySelector('.custom-select-arrow').style.transform = 'rotate(0deg)';
          d.previousElementSibling.style.borderColor = '#3a3a48';
        });
        openDropdown();
      }
    }

    display.addEventListener('click', toggleDropdown);
    if (searchInput) {
      searchInput.addEventListener('click', (e) => e.stopPropagation());
      searchInput.addEventListener('input', () => renderOptions(searchInput.value));
      searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeDropdown();
        if (e.key === 'Enter') {
          const first = optionsContainer.querySelector('.custom-select-option');
          if (first) first.click();
        }
      });
    }

    document.addEventListener('click', (e) => {
      if (!wrapper.contains(e.target)) closeDropdown();
    });

    const observer = new MutationObserver(() => {
      updateDisplay();
      if (dropdown.style.display === 'block') renderOptions(searchInput ? searchInput.value : null);
    });
    observer.observe(originalSelect, { childList: true, attributes: true, subtree: true });

    originalSelect.addEventListener('change', () => {
      updateDisplay();
      renderOptions();
    });

    updateDisplay();

    wrapper._customSelect = {
      refresh: () => { updateDisplay(); renderOptions(); },
      open: openDropdown,
      close: closeDropdown
    };

    return wrapper;
  }

  function convertAllSelects(container) {
    const root = container || document;
    const selects = root.querySelectorAll('select:not([data-custom-select-converted])');
    selects.forEach(convertSelect);
  }

  window.CustomSelect = {
    convert: convertSelect,
    convertAll: convertAllSelects,
    sync: function(selectEl) {
      if (!selectEl || selectEl.tagName !== 'SELECT') return;
      const wrapper = selectEl.closest('.custom-select-wrapper');
      if (wrapper && wrapper._customSelect) wrapper._customSelect.refresh();
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => convertAllSelects());
  } else {
    convertAllSelects();
  }

  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === 1) {
          if (node.tagName === 'SELECT') {
            convertSelect(node);
          } else {
            const selects = node.querySelectorAll ? node.querySelectorAll('select:not([data-custom-select-converted])') : [];
            selects.forEach(convertSelect);
          }
        }
      });
    });
  });
  observer.observe(document.body || document.documentElement, { childList: true, subtree: true });

  console.log('[CustomSelect] 自定义下拉菜单组件已加载（搜索需 data-search="true"）');
})();
