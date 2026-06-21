const TAB_META_KEY = "fruitTabCards:tabMeta";

async function getMeta() {
  const data = await chrome.storage.local.get(TAB_META_KEY);
  return data[TAB_META_KEY] || {};
}

async function setMeta(meta) {
  await chrome.storage.local.set({ [TAB_META_KEY]: meta });
}

async function ensureTabsHaveFirstSeen() {
  const meta = await getMeta();
  const tabs = await chrome.tabs.query({});
  const now = Date.now();
  let changed = false;

  for (const tab of tabs) {
    if (!meta[tab.id]) {
      meta[tab.id] = { firstSeen: now };
      changed = true;
    }
  }

  const liveIds = new Set(tabs.map((tab) => String(tab.id)));
  for (const tabId of Object.keys(meta)) {
    if (!liveIds.has(tabId)) {
      delete meta[tabId];
      changed = true;
    }
  }

  if (changed) await setMeta(meta);
  return meta;
}

chrome.runtime.onInstalled.addListener(() => {
  ensureTabsHaveFirstSeen();
});

chrome.runtime.onStartup.addListener(() => {
  ensureTabsHaveFirstSeen();
});

chrome.tabs.onCreated.addListener(async (tab) => {
  const meta = await getMeta();
  meta[tab.id] = { firstSeen: Date.now() };
  await setMeta(meta);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const meta = await getMeta();
  delete meta[tabId];
  await setMeta(meta);
});

chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL("popup.html");
  const existing = await chrome.tabs.query({ url });

  if (existing[0]) {
    await chrome.tabs.update(existing[0].id, { active: true });
    await chrome.windows.update(existing[0].windowId, { focused: true });
    return;
  }

  await chrome.tabs.create({ url });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "GET_TAB_META") return false;

  ensureTabsHaveFirstSeen()
    .then((meta) => sendResponse({ ok: true, meta }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));

  return true;
});
