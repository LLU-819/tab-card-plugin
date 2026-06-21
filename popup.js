const COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];
const GROUP_COLOR_CLASS = {
  grey: "grey",
  blue: "blue",
  red: "red",
  yellow: "lime",
  green: "green",
  pink: "pink",
  purple: "purple",
  cyan: "cyan",
  orange: ""
};

const ICONS = {
  add: "add",
  arrowDown: "arrow-down",
  arrowRight: "arrow-right",
  close: "close",
  favorite: "favorite",
  left: "direction-left",
  refresh: "refresh",
  restore: "restore",
  search: "search",
  trash: "trash",
  ungroup: "unlock"
};

const CLOSED_TABS_KEY = "fruitTabCards:closedTabs";
const MAX_CLOSED_TABS = 80;
const REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const FILTER_LABELS = {
  all: "全部",
  recommended: "建议关闭",
  duplicate: "重复",
  bookmarked: "已收藏"
};

const state = {
  tabs: [],
  groups: [],
  draftGroups: loadDraftGroups(),
  closedTabs: loadClosedTabs(),
  meta: {},
  bookmarks: new Set(),
  memoryByTab: new Map(),
  filter: "all",
  groupFilter: "all",
  view: "board",
  sidebarCollapsed: localStorage.getItem("sidebarCollapsed") === "true",
  collapsedGroups: loadCollapsedGroups(),
  pendingFocusGroupId: null,
  pendingScrollGroupId: null,
  suppressCardClickUntil: 0,
  query: "",
  windowId: null
};

const els = {
  app: document.querySelector(".app"),
  windowLabel: document.querySelector("#windowLabel"),
  totalMemory: document.querySelector("#totalMemory"),
  closeCount: document.querySelector("#closeCount"),
  duplicateCount: document.querySelector("#duplicateCount"),
  groupCount: document.querySelector("#groupCount"),
  groupList: document.querySelector("#groupList"),
  cardBoard: document.querySelector("#cardBoard"),
  compactGrid: document.querySelector("#compactGrid"),
  closedGrid: document.querySelector("#closedGrid"),
  closedCount: document.querySelector("#closedCount"),
  closedTabsBtn: document.querySelector("#closedTabsBtn"),
  searchInput: document.querySelector("#searchInput"),
  filters: document.querySelector("#filters"),
  newGroupDrop: document.querySelector("#newGroupDrop"),
  newGroupBtn: document.querySelector("#newGroupBtn"),
  sidebarToggleBtn: document.querySelector("#sidebarToggleBtn"),
  refreshBtn: document.querySelector("#refreshBtn"),
  closeRecommendedBtn: document.querySelector("#closeRecommendedBtn")
};

function setSidebarCollapsed(collapsed) {
  state.sidebarCollapsed = collapsed;
  localStorage.setItem("sidebarCollapsed", String(collapsed));
  els.app.classList.toggle("sidebar-collapsed", collapsed);
  els.sidebarToggleBtn.innerHTML = icon(collapsed ? "arrowRight" : "left");
  els.sidebarToggleBtn.title = collapsed ? "展开侧栏" : "收起侧栏";
  els.sidebarToggleBtn.setAttribute("aria-label", collapsed ? "展开侧栏" : "收起侧栏");
  els.sidebarToggleBtn.setAttribute("aria-expanded", String(!collapsed));
}

function loadDraftGroups() {
  try {
    const groups = JSON.parse(localStorage.getItem("draftGroups") || "[]");
    return Array.isArray(groups) ? groups.filter((group) => group?.id && group?.title) : [];
  } catch {
    return [];
  }
}

function saveDraftGroups() {
  localStorage.setItem("draftGroups", JSON.stringify(state.draftGroups));
}

function loadClosedTabs() {
  try {
    const tabs = JSON.parse(localStorage.getItem(CLOSED_TABS_KEY) || "[]");
    return Array.isArray(tabs)
      ? tabs.filter((tab) => tab?.id && tab?.url).slice(0, MAX_CLOSED_TABS)
      : [];
  } catch {
    return [];
  }
}

function saveClosedTabs() {
  localStorage.setItem(CLOSED_TABS_KEY, JSON.stringify(state.closedTabs.slice(0, MAX_CLOSED_TABS)));
}

function loadCollapsedGroups() {
  try {
    const ids = JSON.parse(localStorage.getItem("collapsedGroups") || "[]");
    return new Set(Array.isArray(ids) ? ids.map(String) : []);
  } catch {
    return new Set();
  }
}

function saveCollapsedGroups() {
  localStorage.setItem("collapsedGroups", JSON.stringify([...state.collapsedGroups]));
}

function syncCollapsedGroups() {
  const validIds = new Set(["-1", ...state.groups.map((group) => String(group.id)), ...state.draftGroups.map((group) => group.id)]);
  state.collapsedGroups = new Set([...state.collapsedGroups].filter((id) => validIds.has(id)));
  for (const group of state.groups) {
    if (group.collapsed) state.collapsedGroups.add(String(group.id));
  }
  saveCollapsedGroups();
}

function isDraftGroupId(groupId) {
  return String(groupId).startsWith("draft-");
}

function randomGroupColor() {
  return COLORS[Math.floor(Math.random() * COLORS.length)] || "orange";
}

function callChrome(fn, ...args) {
  return new Promise((resolve, reject) => {
    fn(...args, (result) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result);
    });
  });
}

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => resolve(response || { ok: false }));
  });
}

async function loadState() {
  const currentWindow = await chrome.windows.getCurrent();
  state.windowId = currentWindow.id;
  const metaResponse = await sendMessage({ type: "GET_TAB_META" });

  state.tabs = await chrome.tabs.query({ windowId: state.windowId });
  state.groups = await chrome.tabGroups.query({ windowId: state.windowId });
  state.meta = metaResponse.ok ? metaResponse.meta : {};
  state.memoryByTab = await getMemoryByTab();
  state.bookmarks = await getBookmarkedUrls(state.tabs);
  syncCollapsedGroups();
}

async function getBookmarkedUrls(tabs) {
  const urls = new Set();
  await Promise.all(tabs.map(async (tab) => {
    if (!isBookmarkable(tab.url)) return;
    try {
      const results = await chrome.bookmarks.search({ url: tab.url });
      if (results.length) urls.add(tab.url);
    } catch {
      /* Some internal pages are not bookmark-searchable. */
    }
  }));
  return urls;
}

async function getMemoryByTab() {
  const memoryByTab = new Map();

  if (chrome.processes?.getProcessInfo) {
    try {
      const processes = await callChrome(chrome.processes.getProcessInfo, [], true);
      for (const processInfo of Object.values(processes || {})) {
        const tabIds = [...new Set((processInfo.tasks || [])
          .map((task) => task.tabId)
          .filter((tabId) => Number.isInteger(tabId)))];
        if (!tabIds.length || !processInfo.privateMemory) continue;
        const share = processInfo.privateMemory / tabIds.length;
        for (const tabId of tabIds) memoryByTab.set(tabId, share);
      }
      if (memoryByTab.size) return memoryByTab;
    } catch {
      memoryByTab.clear();
    }
  }

  await Promise.all(state.tabs.map(async (tab) => {
    if (!/^https?:\/\//.test(tab.url || "")) return;
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => performance.memory?.usedJSHeapSize || 0
      });
      if (result) memoryByTab.set(tab.id, result);
    } catch {
      /* Pages without host access or restricted frames simply show unavailable memory. */
    }
  }));

  return memoryByTab;
}

function normalizedUrl(url) {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    if (parsed.pathname.endsWith("/") && parsed.pathname.length > 1) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    return parsed.toString();
  } catch {
    return url || "";
  }
}

function isBookmarkable(url) {
  return /^https?:\/\//.test(url || "");
}

function hostFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "internal";
  }
}

function formatDuration(firstSeen) {
  const started = Number(firstSeen) || Date.now();
  const minutes = Math.max(0, Math.floor((Date.now() - started) / 60000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天`;
}

function formatMemory(bytes) {
  if (!bytes) return "--";
  if (bytes > 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)}GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))}MB`;
}

function getLastAccessed(tab) {
  const lastAccessed = Number(tab.lastAccessed);
  return Number.isFinite(lastAccessed) && lastAccessed > 0 ? lastAccessed : Date.now();
}

function getDuplicates() {
  const byUrl = new Map();
  for (const tab of state.tabs) {
    const key = normalizedUrl(tab.url);
    if (!key) continue;
    byUrl.set(key, [...(byUrl.get(key) || []), tab]);
  }

  const duplicates = new Set();
  for (const tabs of byUrl.values()) {
    if (tabs.length <= 1) continue;
    const keeper = [...tabs].sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return getLastAccessed(b) - getLastAccessed(a);
    })[0];

    for (const tab of tabs) {
      if (tab.id !== keeper.id) duplicates.add(tab.id);
    }
  }
  return duplicates;
}

function getTabModel(tab, duplicates = getDuplicates()) {
  const group = state.groups.find((item) => item.id === tab.groupId);
  const firstSeen = getLastAccessed(tab);
  const memory = state.memoryByTab.get(tab.id);
  const hoursOpen = (Date.now() - firstSeen) / 3600000;
  const duplicate = duplicates.has(tab.id);
  const recommended = !tab.active && (duplicate || tab.discarded || hoursOpen >= 4 || (memory && memory > 450 * 1024 * 1024));

  return {
    ...tab,
    duplicate,
    recommended,
    memory,
    firstSeen,
    group,
    bookmarked: state.bookmarks.has(tab.url)
  };
}

function filteredTabs() {
  return groupScopedTabs().filter(matchesCurrentFilter);
}

function groupScopedTabs() {
  return scopedTabs().filter((tab) =>
    state.groupFilter === "all" ||
    (state.groupFilter === "-1" && tab.groupId === -1) ||
    String(tab.groupId) === state.groupFilter
  );
}

function matchesCurrentFilter(tab) {
  return state.filter === "all" ||
    (state.filter === "recommended" && tab.recommended) ||
    (state.filter === "duplicate" && tab.duplicate) ||
    (state.filter === "bookmarked" && tab.bookmarked);
}

function scopedTabs() {
  const query = state.query.trim().toLowerCase();
  const duplicates = getDuplicates();

  return state.tabs
    .map((tab) => getTabModel(tab, duplicates))
    .filter((tab) => {
      const groupName = tab.group?.title || "未分组";
      const matchesQuery = !query || [tab.title, tab.url, groupName, hostFromUrl(tab.url)]
        .some((value) => String(value || "").toLowerCase().includes(query));

      return matchesQuery;
    });
}

function renderFilterCounts(tabs) {
  const counts = {
    all: tabs.length,
    recommended: tabs.filter((tab) => tab.recommended).length,
    duplicate: tabs.filter((tab) => tab.duplicate).length,
    bookmarked: tabs.filter((tab) => tab.bookmarked).length
  };

  els.filters.querySelectorAll("[data-filter]").forEach((button) => {
    const filter = button.dataset.filter;
    button.textContent = `${FILTER_LABELS[filter]}（${counts[filter] ?? 0}）`;
    button.classList.toggle("active", state.filter === filter);
  });
}

function render() {
  const tabs = filteredTabs();

  renderSummaryStats();
  renderGroupList(scopedTabs());
  renderBoard(tabs);
  renderCompact(tabs);
  renderClosedTabs();
  updateViewState();
  focusPendingGroupName();
  scrollPendingGroupIntoView();
}

function renderSummaryStats() {
  const duplicateIds = getDuplicates();
  const models = state.tabs.map((tab) => getTabModel(tab, duplicateIds));
  const recommended = models.filter((tab) => tab.recommended);
  const totalMemory = [...state.memoryByTab.values()].reduce((sum, bytes) => sum + bytes, 0);

  els.windowLabel.textContent = `${state.tabs.length} tabs`;
  els.totalMemory.textContent = totalMemory ? formatMemory(totalMemory) : "--";
  els.closeCount.textContent = recommended.length;
  els.duplicateCount.textContent = duplicateIds.size;
  els.groupCount.textContent = state.groups.length + state.draftGroups.length;
  els.closedCount.textContent = state.closedTabs.length;

  renderFilterCounts(groupScopedTabs());
}

function updateViewState() {
  document.querySelectorAll(".segmented button").forEach((button) => {
    button.classList.toggle("active", state.view === button.dataset.view);
  });
  document.querySelectorAll(".view").forEach((view) => view.classList.toggle("active", view.id === `${state.view}View`));
  els.closedTabsBtn.classList.toggle("active", state.view === "closed");
}

function renderGroupList(tabs) {
  const counts = new Map();
  for (const tab of tabs) counts.set(tab.groupId, (counts.get(tab.groupId) || 0) + 1);

  const fixedItems = [
    { id: "all", title: "全部标签", count: tabs.length, meta: true },
    { id: "-1", title: "未分组", count: counts.get(-1) || 0, meta: true },
  ];
  const groupItems = [
    ...state.groups.map((group) => ({
      id: String(group.id),
      title: group.title || "未命名组",
      color: group.color,
      count: counts.get(group.id) || 0,
      editable: true
    })),
    ...state.draftGroups.map((group) => ({
      ...group,
      count: 0,
      draft: true,
      editable: true
    }))
  ];

  els.groupList.innerHTML = `
    <div class="group-meta-row">
      ${fixedItems.map(renderGroupListItem).join("")}
    </div>
    ${groupItems.map(renderGroupListItem).join("")}
  `;
}

function renderGroupListItem(item) {
  return `
    <div class="group-item ${item.meta ? "meta" : ""} ${state.groupFilter === item.id ? "active" : ""} ${item.draft ? "draft-drop" : ""}" data-group-filter="${item.id}" ${item.id === "all" ? "" : `data-drop-group="${item.id}"`}>
      ${item.meta ? "" : `<span class="dot ${GROUP_COLOR_CLASS[item.color] || ""}"></span>`}
      <span class="group-text">
        ${item.editable
          ? `<input class="group-list-name" data-group-name="${item.id}" value="${escapeAttr(item.title)}" title="修改组名" />`
          : `<b>${escapeHtml(item.title)}</b>`}
      </span>
      <span class="pill">${item.count}</span>
      ${item.editable ? renderGroupListActions(item) : ""}
    </div>
  `;
}

function renderGroupListActions(item) {
  if (item.draft) {
    return `<button class="group-action group-delete" data-group-delete="${item.id}" title="删除草稿组" aria-label="删除草稿组">${icon("close")}</button>`;
  }

  return `
    <span class="group-actions">
      <button class="group-action group-ungroup" data-group-ungroup="${item.id}" title="取消分组" aria-label="取消分组">${icon("ungroup")}</button>
      <button class="group-action group-delete" data-group-delete="${item.id}" title="删除分组并关闭组内标签" aria-label="删除分组并关闭组内标签">${icon("close")}</button>
    </span>
  `;
}

function renderBoard(tabs) {
  const showEmptyGroups = state.filter === "all";
  const lanes = [
    { id: -1, title: "未分组", color: "grey", tabs: tabs.filter((tab) => tab.groupId === -1) },
    ...state.groups.map((group) => ({
      ...group,
      title: group.title || "未命名组",
      tabs: tabs.filter((tab) => tab.groupId === group.id)
    })),
    ...state.draftGroups.map((group) => ({
      ...group,
      tabs: [],
      draft: true
    }))
  ].filter((lane) =>
    (state.groupFilter === "all" || String(lane.id) === state.groupFilter) &&
    (showEmptyGroups || lane.tabs.length > 0)
  );

  els.cardBoard.innerHTML = lanes.map((lane) => `
    <section class="lane ${state.collapsedGroups.has(String(lane.id)) ? "collapsed" : ""} ${state.groupFilter === String(lane.id) ? "selected" : ""} ${lane.draft ? "draft-drop" : ""}" data-group-id="${lane.id}">
      <div class="lane-head">
        <div class="lane-title">
          <button class="lane-collapse" data-group-collapse="${lane.id}" title="${state.collapsedGroups.has(String(lane.id)) ? "展开分组" : "折叠分组"}" aria-label="${state.collapsedGroups.has(String(lane.id)) ? "展开分组" : "折叠分组"}" aria-expanded="${String(!state.collapsedGroups.has(String(lane.id)))}">${icon(state.collapsedGroups.has(String(lane.id)) ? "arrowRight" : "arrowDown")}</button>
          <span class="dot ${GROUP_COLOR_CLASS[lane.color] || ""}"></span>
          ${lane.id === -1
            ? `<span class="group-title-text">未分组（${lane.tabs.length}）</span>`
            : `<label class="group-name-wrap"><input class="group-name" data-group-name="${lane.id}" value="${escapeAttr(lane.title)}" title="修改组名" /><span class="group-count-inline">（${lane.tabs.length}）</span></label>`}
        </div>
        ${renderLaneActions(lane)}
      </div>
      <div class="cards" data-drop-group="${lane.id}">
        ${lane.tabs.length ? lane.tabs.map((tab, index) => renderTabCard(tab, index)).join("") : `<div class="empty-lane">${lane.draft ? "拖入创建" : "拖到这里"}</div>`}
      </div>
    </section>
  `).join("");
}

function renderLaneActions(lane) {
  if (lane.id === -1) return "";
  if (lane.draft) {
    return `
      <div class="lane-actions">
        ${renderColorSelect(lane)}
        <button class="group-action group-delete" data-group-delete="${lane.id}" title="删除草稿组" aria-label="删除草稿组">${icon("close")}</button>
      </div>
    `;
  }

  return `
    <div class="lane-actions">
      <button class="group-action group-ungroup" data-group-ungroup="${lane.id}" title="取消分组" aria-label="取消分组">${icon("ungroup")}</button>
      ${renderColorSelect(lane)}
      <button class="group-action group-delete" data-group-delete="${lane.id}" title="删除分组并关闭组内标签" aria-label="删除分组并关闭组内标签">${icon("close")}</button>
    </div>
  `;
}

function renderColorSelect(group) {
  return `
    <select class="group-color ${GROUP_COLOR_CLASS[group.color] || "orange"}" data-group-color="${group.id}" title="修改组颜色" aria-label="修改组颜色">
      ${COLORS.map((color) => `<option value="${color}" ${group.color === color ? "selected" : ""}>${color}</option>`).join("")}
    </select>
  `;
}

function renderTabCard(tab, index = 0) {
  return `
    <article class="tab-card ${tab.active ? "active-tab" : ""}" draggable="true" data-tab-id="${tab.id}" data-index="${String(index + 1).padStart(2, "0")}" title="单击跳转，拖拽到标签组">
      <div class="tab-main">
        ${renderFavicon(tab)}
        <div class="tab-text">
          <div class="tab-title">${escapeHtml(tab.title || "Untitled")}</div>
          <div class="tab-url">${escapeHtml(tab.url || "")}</div>
        </div>
        <div class="actions">
          <button class="card-icon ${tab.bookmarked ? "saved" : ""}" data-action="bookmark" data-tab-id="${tab.id}" title="${tab.bookmarked ? "取消收藏" : "收藏"}" aria-pressed="${String(tab.bookmarked)}">${icon("favorite")}</button>
          <button class="card-icon close" data-action="close" data-tab-id="${tab.id}" title="关闭标签">${icon("close")}</button>
        </div>
      </div>
      <div class="tag-row">
        ${renderTabBadges(tab)}
      </div>
      <div class="card-meta-row">
        <div class="metric"><span>内存</span><b>${formatMemory(tab.memory)}</b></div>
        <div class="metric"><span>打开</span><b>${formatDuration(tab.firstSeen)}</b></div>
        <div class="card-foot">
          <span>${escapeHtml(hostFromUrl(tab.url))}</span>
        </div>
      </div>
    </article>
  `;
}

function renderCompact(tabs) {
  els.compactGrid.innerHTML = tabs.map(renderCompactCard).join("");
}

function renderCompactCard(tab) {
  return `
    <article class="compact-card" draggable="true" data-tab-id="${tab.id}" title="单击跳转，拖拽到标签组">
      <div class="compact-top">
        ${renderFavicon(tab)}
        <div class="mini-title">${escapeHtml(tab.title || "Untitled")}</div>
        <button class="mini-action" data-action="close" data-tab-id="${tab.id}" title="关闭">${icon("close")}</button>
      </div>
      <div class="compact-row"><span>${formatMemory(tab.memory)}</span><span>${formatDuration(tab.firstSeen)}</span></div>
      <div class="compact-row"><span>${tab.active ? "当前标签" : "后台标签"}</span><span>${tab.recommended ? "建议关闭" : "保留"}</span></div>
    </article>
  `;
}

function renderClosedTabs() {
  const query = state.query.trim().toLowerCase();
  const closedTabs = state.closedTabs.filter((tab) => {
    if (!query) return true;
    return [tab.title, tab.url, tab.groupTitle, hostFromUrl(tab.url)]
      .some((value) => String(value || "").toLowerCase().includes(query));
  });

  els.closedGrid.innerHTML = closedTabs.length
    ? closedTabs.map(renderClosedTabCard).join("")
    : `<div class="empty-lane closed-empty">${state.closedTabs.length ? "没有匹配的关闭记录" : "暂无已关闭标签"}</div>`;
}

function renderClosedTabCard(tab) {
  return `
    <article class="closed-card" data-closed-id="${escapeAttr(tab.id)}">
      <div class="tab-main">
        ${renderFavicon(tab)}
        <div class="tab-text">
          <div class="tab-title">${escapeHtml(tab.title || "Untitled")}</div>
        </div>
        <button class="restore-button" data-action="restore" data-closed-id="${escapeAttr(tab.id)}" title="复原标签" aria-label="复原标签">${icon("restore")}</button>
      </div>
      <div class="tab-url">${escapeHtml(tab.url || "")}</div>
      <div class="tag-row">
        <span class="badge">关闭 ${formatDuration(tab.closedAt)}</span>
        ${tab.groupTitle ? `<span class="badge group">${escapeHtml(tab.groupTitle)}</span>` : ""}
      </div>
      <div class="card-foot">
        <span>${escapeHtml(hostFromUrl(tab.url))}</span>
      </div>
    </article>
  `;
}

function renderFavicon(tab) {
  if (tab.favIconUrl) {
    return `<div class="favicon favicon-image"><img src="${escapeAttr(tab.favIconUrl)}" alt="" /></div>`;
  }
  const initial = (hostFromUrl(tab.url)[0] || "T").toUpperCase();
  return `<div class="favicon">${escapeHtml(initial)}</div>`;
}

function renderTabBadges(tab) {
  return `
        ${tab.active ? `<span class="badge active">当前页面</span>` : ""}
        ${tab.recommended ? `<span class="badge close">建议关闭</span>` : ""}
        ${tab.duplicate ? `<span class="badge dup">重复 Tab</span>` : ""}
        ${tab.bookmarked ? `<span class="badge bookmark">已收藏</span>` : ""}
      `;
}

function updateVisibleCardBadges(tabIds) {
  const duplicates = getDuplicates();
  for (const tabId of tabIds) {
    const tab = state.tabs.find((item) => item.id === tabId);
    if (!tab) continue;
    const badges = renderTabBadges(getTabModel(tab, duplicates));
    document.querySelectorAll(`.tab-card[data-tab-id="${CSS.escape(String(tabId))}"] .tag-row`)
      .forEach((row) => {
        row.innerHTML = badges;
      });
  }
}

function updateBookmarkButtonState(button, bookmarked) {
  button.classList.toggle("saved", bookmarked);
  button.title = bookmarked ? "取消收藏" : "收藏";
  button.setAttribute("aria-pressed", String(bookmarked));
}

function shouldShowTab(tab) {
  return filteredTabs().some((item) => item.id === tab.id);
}

function removeTabElements(tabId) {
  document.querySelectorAll(`.tab-card[data-tab-id="${CSS.escape(String(tabId))}"], .compact-card[data-tab-id="${CSS.escape(String(tabId))}"]`)
    .forEach((card) => {
      const cardsWrap = card.closest(".cards");
      const lane = card.closest(".lane");
      card.classList.add("is-removing");

      setTimeout(() => {
        card.remove();
        if (!cardsWrap || cardsWrap.querySelector(".tab-card")) return;
        const isDraft = lane?.classList.contains("draft-drop");
        cardsWrap.innerHTML = `<div class="empty-lane">${isDraft ? "拖入创建" : "拖到这里"}</div>`;
      }, 180);
    });
}

function updateLaneCounts() {
  const counts = new Map();
  for (const tab of filteredTabs()) counts.set(tab.groupId, (counts.get(tab.groupId) || 0) + 1);

  els.cardBoard.querySelectorAll("[data-group-id]").forEach((lane) => {
    const groupId = lane.dataset.groupId;
    const count = counts.get(Number(groupId)) || 0;
    const ungroupedTitle = lane.querySelector(".group-title-text");
    const inlineCount = lane.querySelector(".group-count-inline");

    if (ungroupedTitle) ungroupedTitle.textContent = `未分组（${count}）`;
    if (inlineCount) inlineCount.textContent = `（${count}）`;
  });
}

function updateGroupListCounts() {
  const tabs = scopedTabs();
  const counts = new Map();
  for (const tab of tabs) counts.set(tab.groupId, (counts.get(tab.groupId) || 0) + 1);

  els.groupList.querySelectorAll("[data-group-filter]").forEach((item) => {
    const groupId = item.dataset.groupFilter;
    const countEl = item.querySelector(":scope > .pill");
    if (!countEl) return;

    if (groupId === "all") {
      countEl.textContent = tabs.length;
      return;
    }

    countEl.textContent = counts.get(Number(groupId)) || 0;
  });
}

function syncAfterLocalTabChange() {
  if (state.filter !== "all") {
    render();
    return;
  }

  renderSummaryStats();
  updateGroupListCounts();
  updateLaneCounts();
}

function insertRestoredTabElements(tab) {
  if (!shouldShowTab(tab)) return;

  const model = getTabModel(tab);
  const ungroupedCards = els.cardBoard.querySelector('[data-group-id="-1"] .cards');
  if (ungroupedCards && !ungroupedCards.querySelector(`[data-tab-id="${CSS.escape(String(tab.id))}"]`)) {
    ungroupedCards.querySelector(".empty-lane")?.remove();
    const ungroupedVisibleCount = filteredTabs().filter((item) => item.groupId === -1).length;
    ungroupedCards.insertAdjacentHTML("beforeend", renderTabCard(model, ungroupedVisibleCount - 1));
  }

  if (!els.compactGrid.querySelector(`[data-tab-id="${CSS.escape(String(tab.id))}"]`)) {
    els.compactGrid.insertAdjacentHTML("beforeend", renderCompactCard(model));
  }
}

function getClosedTabSnapshot(tab) {
  const group = state.groups.find((item) => item.id === tab.groupId);
  return {
    id: `${Date.now()}-${tab.id}-${Math.random().toString(16).slice(2)}`,
    url: tab.url,
    title: tab.title || tab.url || "Untitled",
    favIconUrl: tab.favIconUrl || "",
    memory: state.memoryByTab.get(tab.id) || 0,
    closedAt: Date.now(),
    groupId: tab.groupId,
    groupTitle: group?.title || "",
    groupColor: group?.color || "",
    pinned: Boolean(tab.pinned)
  };
}

function rememberClosedTabs(tabs) {
  const restorable = tabs.filter((tab) => tab.url);
  if (!restorable.length) return;
  state.closedTabs = [
    ...restorable.map(getClosedTabSnapshot),
    ...state.closedTabs
  ].slice(0, MAX_CLOSED_TABS);
  saveClosedTabs();
  renderClosedTabs();
  els.closedCount.textContent = state.closedTabs.length;
}

async function closeTab(tabId) {
  const tab = state.tabs.find((item) => item.id === tabId);
  if (!tab) return;

  await chrome.tabs.remove(tabId);
  rememberClosedTabs([tab]);
  const closedUrl = normalizedUrl(tab.url);
  state.tabs = state.tabs.filter((item) => item.id !== tabId);
  state.memoryByTab.delete(tabId);
  removeTabElements(tabId);

  const relatedDuplicateIds = state.tabs
    .filter((item) => normalizedUrl(item.url) === closedUrl)
    .map((item) => item.id);
  updateVisibleCardBadges(relatedDuplicateIds);
  syncAfterLocalTabChange();
}

async function restoreClosedTab(closedId) {
  const closedTab = state.closedTabs.find((tab) => tab.id === closedId);
  if (!closedTab) return;

  let restoredTab;
  try {
    restoredTab = await chrome.tabs.create({
      url: closedTab.url,
      active: false,
      pinned: closedTab.pinned,
      windowId: state.windowId
    });
  } catch (error) {
    alert(`无法复原该标签：${error.message}`);
    return;
  }

  state.closedTabs = state.closedTabs.filter((tab) => tab.id !== closedId);
  saveClosedTabs();
  const restoredModel = {
    ...restoredTab,
    groupId: -1,
    url: closedTab.url,
    title: closedTab.title || closedTab.url || restoredTab.title || "Untitled",
    favIconUrl: closedTab.favIconUrl || restoredTab.favIconUrl || ""
  };
  state.tabs.push(restoredModel);
  state.meta[restoredTab.id] = { firstSeen: Date.now() };
  if (closedTab.memory) state.memoryByTab.set(restoredTab.id, closedTab.memory);
  insertRestoredTabElements(restoredModel);

  const card = els.closedGrid.querySelector(`[data-closed-id="${CSS.escape(closedId)}"]`);
  card?.classList.add("is-removing");
  setTimeout(renderClosedTabs, 180);

  syncAfterLocalTabChange();
}

async function toggleBookmark(tabId) {
  const tab = state.tabs.find((item) => item.id === tabId);
  if (!tab || !isBookmarkable(tab.url)) return;

  const existing = await chrome.bookmarks.search({ url: tab.url });
  let bookmarked;
  if (existing.length) {
    await Promise.all(existing.map((bookmark) => chrome.bookmarks.remove(bookmark.id).catch(() => undefined)));
    state.bookmarks.delete(tab.url);
    bookmarked = false;
  } else {
    await chrome.bookmarks.create({ title: tab.title || tab.url, url: tab.url });
    state.bookmarks.add(tab.url);
    bookmarked = true;
  }

  document.querySelectorAll(`.card-icon[data-action="bookmark"][data-tab-id="${CSS.escape(String(tabId))}"]`)
    .forEach((button) => {
      updateBookmarkButtonState(button, bookmarked);
      delete button.dataset.feedback;
    });

  updateVisibleCardBadges([tabId]);
  if (!shouldShowTab(tab)) removeTabElements(tabId);
  syncAfterLocalTabChange();
}

async function createGroupWithTab(tabId) {
  const groupId = await chrome.tabs.group({ tabIds: [tabId] });
  await chrome.tabGroups.update(groupId, { title: "新标签组", color: randomGroupColor() });
  state.groupFilter = String(groupId);
  await refresh();
}

function createDraftGroup() {
  const group = {
    id: `draft-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    title: "新标签组",
    color: randomGroupColor()
  };
  state.draftGroups.push(group);
  state.groupFilter = group.id;
  state.pendingFocusGroupId = group.id;
  saveDraftGroups();
  render();
}

function updateDraftGroup(groupId, patch) {
  const group = state.draftGroups.find((item) => item.id === groupId);
  if (!group) return;
  Object.assign(group, patch);
  saveDraftGroups();
}

async function materializeDraftGroup(tabId, draftGroupId) {
  const draft = state.draftGroups.find((group) => group.id === draftGroupId);
  if (!draft) return;
  const groupId = await chrome.tabs.group({ tabIds: [tabId] });
  await chrome.tabGroups.update(groupId, { title: draft.title || "新标签组", color: draft.color || "orange" });
  state.draftGroups = state.draftGroups.filter((group) => group.id !== draftGroupId);
  state.groupFilter = String(groupId);
  saveDraftGroups();
  await refresh();
}

async function moveTabToGroup(tabId, groupId) {
  if (isDraftGroupId(groupId)) {
    await materializeDraftGroup(tabId, groupId);
    return;
  }

  if (groupId === -1) {
    await chrome.tabs.ungroup(tabId);
  } else {
    await chrome.tabs.group({ tabIds: [tabId], groupId });
  }
  await refresh();
}

async function toggleGroupCollapse(groupId) {
  const key = String(groupId);
  const collapsed = !state.collapsedGroups.has(key);
  if (collapsed) state.collapsedGroups.add(key);
  else state.collapsedGroups.delete(key);
  saveCollapsedGroups();

  if (!isDraftGroupId(key) && key !== "-1") {
    try {
      await chrome.tabGroups.update(Number(key), { collapsed });
    } catch {
      /* Board collapse still works if Chrome rejects a transient group update. */
    }
  }
  render();
}

async function ungroupGroup(groupId) {
  if (isDraftGroupId(groupId)) {
    state.draftGroups = state.draftGroups.filter((group) => group.id !== groupId);
    if (state.groupFilter === groupId) state.groupFilter = "all";
    saveDraftGroups();
    render();
    return;
  }

  const numericGroupId = Number(groupId);
  const tabIds = state.tabs.filter((tab) => tab.groupId === numericGroupId).map((tab) => tab.id);
  if (tabIds.length) await chrome.tabs.ungroup(tabIds);
  if (state.groupFilter === String(groupId)) state.groupFilter = "all";
  state.collapsedGroups.delete(String(groupId));
  saveCollapsedGroups();
  await refresh();
}

async function deleteGroup(groupId) {
  if (isDraftGroupId(groupId)) {
    state.draftGroups = state.draftGroups.filter((group) => group.id !== groupId);
    if (state.groupFilter === groupId) state.groupFilter = "all";
    state.collapsedGroups.delete(String(groupId));
    saveCollapsedGroups();
    saveDraftGroups();
    render();
    return;
  }

  const numericGroupId = Number(groupId);
  const tabIds = state.tabs.filter((tab) => tab.groupId === numericGroupId).map((tab) => tab.id);
  if (!tabIds.length) return;
  const closingTabs = state.tabs.filter((tab) => tabIds.includes(tab.id));
  const group = state.groups.find((item) => item.id === numericGroupId);
  const title = group?.title || "未命名组";
  if (!confirm(`删除“${title}”分组并关闭其中 ${tabIds.length} 个标签页？`)) return;
  await chrome.tabs.remove(tabIds);
  rememberClosedTabs(closingTabs);
  if (state.groupFilter === String(groupId)) state.groupFilter = "all";
  state.collapsedGroups.delete(String(groupId));
  saveCollapsedGroups();
  await refresh();
}

function focusPendingGroupName() {
  if (!state.pendingFocusGroupId) return;
  const input = document.querySelector(`[data-group-name="${CSS.escape(state.pendingFocusGroupId)}"]`);
  if (!input) return;
  requestAnimationFrame(() => {
    input.focus();
    input.select();
    state.pendingFocusGroupId = null;
  });
}

function scrollPendingGroupIntoView() {
  if (!state.pendingScrollGroupId) return;
  const groupId = state.pendingScrollGroupId;
  state.pendingScrollGroupId = null;

  requestAnimationFrame(() => {
    if (groupId === "all") {
      els.cardBoard.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }

    const lane = els.cardBoard.querySelector(`[data-group-id="${CSS.escape(groupId)}"]`);
    lane?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

async function closeRecommendedTabs() {
  const tabs = state.tabs.map((tab) => getTabModel(tab)).filter((tab) => tab.recommended);
  if (!tabs.length) return;
  await chrome.tabs.remove(tabs.map((tab) => tab.id));
  rememberClosedTabs(tabs);
  await refresh();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function activateTab(tabId) {
  const tab = state.tabs.find((item) => item.id === tabId);
  if (!tab) return;

  await chrome.tabs.update(tabId, { active: true });
  if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
}

function removeEmptyGroupsFromState() {
  const counts = new Map();
  for (const tab of state.tabs) counts.set(tab.groupId, (counts.get(tab.groupId) || 0) + 1);

  const emptyGroupIds = state.groups
    .filter((group) => !counts.get(group.id))
    .map((group) => String(group.id));
  const emptyDraftIds = state.draftGroups.map((group) => group.id);

  if (emptyDraftIds.length) {
    state.draftGroups = [];
    saveDraftGroups();
  }

  if (!emptyGroupIds.length && !emptyDraftIds.length) return;

  const removedIds = new Set([...emptyGroupIds, ...emptyDraftIds]);
  state.groups = state.groups.filter((group) => !removedIds.has(String(group.id)));
  state.collapsedGroups = new Set([...state.collapsedGroups].filter((id) => !removedIds.has(id)));
  if (removedIds.has(state.groupFilter)) state.groupFilter = "all";
  saveCollapsedGroups();
}

async function refresh({ removeEmptyGroups = false, showFeedback = false } = {}) {
  if (showFeedback) {
    els.refreshBtn.classList.add("is-refreshing");
    els.refreshBtn.disabled = true;
  }

  try {
    await loadState();
    if (removeEmptyGroups) removeEmptyGroupsFromState();
    render();
  } finally {
    if (showFeedback) {
      setTimeout(() => {
        els.refreshBtn.classList.remove("is-refreshing");
        els.refreshBtn.disabled = false;
      }, 260);
    }
  }
}

function refreshFromButton() {
  return refresh({ removeEmptyGroups: true, showFeedback: true });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}

function icon(name, className = "") {
  const file = ICONS[name];
  return `<span class="svg-icon icon-${file} ${className}" aria-hidden="true"></span>`;
}

document.addEventListener("click", async (event) => {
  const action = event.target.closest("[data-action]");
  if (action) {
    if (action.dataset.action === "restore") {
      await restoreClosedTab(action.dataset.closedId);
      return;
    }

    const tabId = Number(action.dataset.tabId);
    if (action.dataset.action === "close") await closeTab(tabId);
    if (action.dataset.action === "bookmark") {
      const willSave = !action.classList.contains("saved");
      action.dataset.feedback = willSave ? "save" : "remove";
      action.classList.remove("bookmark-feedback");
      action.getBoundingClientRect();
      action.classList.add("bookmark-feedback");
      await delay(180);
      await toggleBookmark(tabId);
    }
    return;
  }

  const groupDelete = event.target.closest("[data-group-delete]");
  if (groupDelete) {
    await deleteGroup(groupDelete.dataset.groupDelete);
    return;
  }

  const groupUngroup = event.target.closest("[data-group-ungroup]");
  if (groupUngroup) {
    await ungroupGroup(groupUngroup.dataset.groupUngroup);
    return;
  }

  const groupCollapse = event.target.closest("[data-group-collapse]");
  if (groupCollapse) {
    await toggleGroupCollapse(groupCollapse.dataset.groupCollapse);
    return;
  }

  const groupFilter = event.target.closest("[data-group-filter]");
  if (groupFilter) {
    if (event.target.closest("input, select, button")) return;
    if (state.view === "closed") state.view = "board";
    state.groupFilter = groupFilter.dataset.groupFilter;
    state.pendingScrollGroupId = state.groupFilter;
    render();
    return;
  }

  const card = event.target.closest("[data-tab-id]");
  if (!card) return;
  if (event.target.closest("input, select, button, a")) return;
  if (Date.now() < state.suppressCardClickUntil) return;
  await activateTab(Number(card.dataset.tabId));
});

document.addEventListener("dragstart", (event) => {
  const card = event.target.closest("[data-tab-id]");
  if (!card) return;
  card.classList.add("dragging");
  event.dataTransfer.setData("text/plain", card.dataset.tabId);
  event.dataTransfer.effectAllowed = "move";
});

document.addEventListener("dragend", (event) => {
  event.target.closest(".tab-card, .compact-card")?.classList.remove("dragging");
  document.querySelectorAll(".target").forEach((el) => el.classList.remove("target"));
  state.suppressCardClickUntil = Date.now() + 150;
});

document.addEventListener("dragover", (event) => {
  const target = event.target.closest("[data-drop-group], #newGroupDrop");
  if (!target) return;
  event.preventDefault();
  target.closest(".lane, .group-item, #newGroupDrop")?.classList.add("target");
});

document.addEventListener("dragleave", (event) => {
  event.target.closest(".lane, .group-item, #newGroupDrop")?.classList.remove("target");
});

document.addEventListener("drop", async (event) => {
  const tabId = Number(event.dataTransfer.getData("text/plain"));
  if (!tabId) return;

  const newGroupTarget = event.target.closest("#newGroupDrop");
  const groupTarget = event.target.closest("[data-drop-group]");
  event.preventDefault();

  if (newGroupTarget) await createGroupWithTab(tabId);
  if (groupTarget) {
    const groupId = groupTarget.dataset.dropGroup;
    await moveTabToGroup(tabId, isDraftGroupId(groupId) ? groupId : Number(groupId));
  }
});

document.addEventListener("change", async (event) => {
  const colorSelect = event.target.closest("[data-group-color]");
  if (!colorSelect) return;
  if (isDraftGroupId(colorSelect.dataset.groupColor)) {
    updateDraftGroup(colorSelect.dataset.groupColor, { color: colorSelect.value });
    render();
    return;
  }
  await chrome.tabGroups.update(Number(colorSelect.dataset.groupColor), { color: colorSelect.value });
  await refresh();
});

document.addEventListener("keydown", async (event) => {
  const nameInput = event.target.closest("[data-group-name]");
  if (nameInput && event.key === "Enter") nameInput.blur();
});

document.addEventListener("focusout", async (event) => {
  const nameInput = event.target.closest("[data-group-name]");
  if (!nameInput) return;
  const title = nameInput.value.trim() || "未命名组";
  if (isDraftGroupId(nameInput.dataset.groupName)) {
    updateDraftGroup(nameInput.dataset.groupName, { title });
    render();
    return;
  }
  await chrome.tabGroups.update(Number(nameInput.dataset.groupName), { title });
  await refresh();
});

document.querySelectorAll(".segmented button").forEach((button) => {
  button.addEventListener("click", () => {
    state.view = button.dataset.view;
    render();
  });
});

els.filters.addEventListener("click", (event) => {
  const chip = event.target.closest("[data-filter]");
  if (!chip) return;
  if (state.view === "closed") state.view = "board";
  state.filter = chip.dataset.filter;
  els.filters.querySelectorAll(".chip").forEach((item) => item.classList.toggle("active", item === chip));
  render();
});

els.searchInput.addEventListener("input", (event) => {
  state.query = event.target.value;
  render();
});

els.sidebarToggleBtn.addEventListener("click", () => {
  setSidebarCollapsed(!state.sidebarCollapsed);
});
els.refreshBtn.addEventListener("click", refreshFromButton);
els.closeRecommendedBtn.addEventListener("click", closeRecommendedTabs);
els.newGroupBtn.addEventListener("click", createDraftGroup);
els.closedTabsBtn.addEventListener("click", () => {
  state.view = "closed";
  render();
});

setSidebarCollapsed(state.sidebarCollapsed);

refresh().catch((error) => {
  document.body.innerHTML = `<main class="page"><section class="app"><div class="main"><div class="hero"><div><h1>无法加载标签页</h1><p class="subtitle">${escapeHtml(error.message)}</p></div></div></div></section></main>`;
});

setInterval(() => {
  refresh().catch(() => undefined);
}, REFRESH_INTERVAL_MS);
