// バックグラウンド（サービスワーカー）。
// ポップアップからの指示で NotebookLM タブを準備し、操作スクリプトを注入してフローを実行する。

const NOTEBOOKLM_URL = "https://notebooklm.google.com/";
const NLM_VERSION = "1.2.1-runner";

// 拡張機能のインストール/リロード時は古いログを破棄する。
// 旧バージョンが保存していた重複判定用の追加履歴（addedVideos）も削除する。
chrome.runtime.onInstalled.addListener(() => {
  clearLogs();
  chrome.storage.local.remove("addedVideos").catch(() => {});
});
chrome.runtime.onStartup?.addListener(() => {
  clearLogs();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "START_NOTEBOOKLM_FLOW") {
    runNotebookLmFlow(message.payload)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        notify("error", error?.message || "NotebookLM の自動操作に失敗しました。");
        sendResponse({ ok: false, error: error?.message });
      });
    return true;
  }

  if (message?.type === "DOWNLOAD_DEBUG_LOG") {
    downloadDebugLog(message.payload)
      .then((downloadId) => sendResponse({ ok: true, downloadId }))
      .catch((error) => sendResponse({ ok: false, error: error?.message }));
    return true;
  }

  return false;
});

async function runNotebookLmFlow(video) {
  validateVideo(video);

  // 新しい実行のたびに、前回の進捗ログ・デバッグログを初期化する。
  await clearLogs();
  notify("info", `対象動画:「${video.title || ""}」/ チャンネル:「${video.channelName || ""}」`);

  // 1. NotebookLM タブを用意する（無ければ作成し、読み込み完了を待つ）。
  const tab = await getOrCreateNotebookLmTab();

  // 2. アクティブ＆前面ウィンドウにする（座標計算を正確にするため）。
  await chrome.tabs.update(tab.id, { active: true });
  if (tab.windowId != null) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
  notify("info", "NotebookLM タブを前面に表示しました");

  // 3. 操作スクリプトの応答を確認する。宣言済みコンテンツスクリプトが未注入なら動的注入する。
  await ensureContentScript(tab.id);

  // 4. 対象ノートブックを解決する。既存ノートブックを開く場合は、カードのクリック（=ページ
  //    リロードでスクリプトが破棄される）を避け、background がタブを直接URL遷移させる。
  const resolved = await resolveNotebook(tab.id, video.channelName);

  notify("info", "NotebookLM の自動操作を開始します");

  // 5. フローを実行する（ノートブックページに到達済み or 新規作成指示）。
  const result = await sendMessageToTab(tab.id, { type: "NLM_RUN_FLOW", payload: { video, resolved } }, 240000);
  if (!result?.ok) {
    throw new Error(result?.error || "NotebookLM の画面操作に失敗しました。");
  }
}

// 対象ノートブックを判定し、必要に応じてタブを遷移させる。
async function resolveNotebook(tabId, channelName) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let r;
    try {
      r = await sendMessageToTab(tabId, { type: "NLM_RESOLVE", payload: { channelName } }, 60000);
    } catch (error) {
      // 遷移直後などで一時的に応答が取れない場合は、スクリプトを確認して再試行する。
      await ensureContentScript(tabId).catch(() => {});
      await delay(800);
      continue;
    }

    if (r?.action === "gohome") {
      notify("info", "別のノートブックが開いているため、ホームに戻ります");
      await chrome.tabs.update(tabId, { url: NOTEBOOKLM_URL });
      await waitForTabComplete(tabId);
      await ensureContentScript(tabId);
      continue;
    }

    if (r?.action === "open" && r.url) {
      notify("info", `既存ノートブック「${r.foundName || ""}」を開きます`);
      await chrome.tabs.update(tabId, { url: r.url });
      await waitForTabComplete(tabId);
      await ensureContentScript(tabId);
      return { action: "open", foundName: r.foundName };
    }

    // already / create / open-click（URL無し）はそのまま content 側で処理する。
    return r || { action: "create" };
  }
  return { action: "create" };
}

// 操作スクリプトが応答するか確認し、未注入なら scripting で注入する。
async function ensureContentScript(tabId) {
  // まず宣言済みコンテンツスクリプトの応答を数回待つ（二重注入を避けるため）。
  for (let i = 0; i < 6; i += 1) {
    if (await pingOk(tabId)) return;
    await delay(500);
  }

  // 既存タブ（拡張機能インストール前から開いていた等）向けのフォールバック注入。
  await injectScript(tabId, ["content/pageWorld.js"], "MAIN");
  await injectScript(tabId, ["content/notebooklm.js"]);

  for (let i = 0; i < 10; i += 1) {
    if (await pingOk(tabId)) return;
    await delay(500);
  }
  throw new Error("NotebookLM の操作スクリプトが応答しません。NotebookLM タブを再読み込みしてからもう一度お試しください。");
}

async function pingOk(tabId) {
  try {
    const response = await sendMessageToTab(tabId, { type: "NLM_PING" }, 4000);
    return response?.version === NLM_VERSION;
  } catch {
    return false;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validateVideo(video) {
  if (!video?.hasCaptions) {
    throw new Error("字幕がないため追加できません");
  }
  if (!video?.channelName || !video?.url) {
    throw new Error("動画情報が不足しています。YouTube ページを再読み込みしてからもう一度お試しください。");
  }
}

async function getOrCreateNotebookLmTab() {
  const tabs = await chrome.tabs.query({ url: "https://notebooklm.google.com/*" });
  if (tabs.length > 0) return tabs[0];

  // 新規作成時は宣言済みコンテンツスクリプトが動くよう、読み込み完了まで待つ。
  const tab = await chrome.tabs.create({ url: NOTEBOOKLM_URL, active: true });
  await waitForTabComplete(tab.id);
  return tab;
}

async function injectScript(tabId, files, world) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files,
      ...(world ? { world } : {})
    });
  } catch (error) {
    if (world === "MAIN") {
      // MAIN world 注入が失敗してもフォールバックで動作可能なため警告のみ。
      notify("info", `補助スクリプトの注入をスキップしました: ${error.message}`);
      return;
    }
    throw new Error(`NotebookLM への操作スクリプト注入に失敗しました: ${error.message}`);
  }
}

async function downloadDebugLog(payload) {
  const text = JSON.stringify(payload || {}, null, 2);
  const dataUrl = `data:application/json;charset=utf-8,${encodeURIComponent(text)}`;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  // saveAs:true により、毎回 保存先フォルダとファイル名を選択できる。
  return chrome.downloads.download({
    url: dataUrl,
    filename: `youtube-to-notebooklm-debug-${stamp}.json`,
    saveAs: true,
    conflictAction: "uniquify"
  });
}

async function clearLogs() {
  await chrome.storage.local.set({ flowStatus: [], debugLog: [] });
}

function waitForTabComplete(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("NotebookLM タブの読み込みがタイムアウトしました。"));
    }, 60000);

    const finish = () => {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      // SPA の初期描画を待つ猶予
      setTimeout(resolve, 1200);
    };

    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") finish();
    };

    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        clearTimeout(timeout);
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (tab?.status === "complete") {
        finish();
        return;
      }
      chrome.tabs.onUpdated.addListener(listener);
    });
  });
}

function sendMessageToTab(tabId, message, timeoutMs) {
  return Promise.race([
    chrome.tabs.sendMessage(tabId, message),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`NotebookLM から応答がありませんでした（${message.type}）。`)), timeoutMs)
    )
  ]);
}

function notify(kind, text) {
  const entry = { kind, text, at: Date.now() };
  chrome.storage.local
    .get({ flowStatus: [] })
    .then((store) => chrome.storage.local.set({ flowStatus: [...store.flowStatus, entry].slice(-60) }))
    .catch(() => {});
  chrome.runtime.sendMessage({ type: "FLOW_STATUS", ...entry }).catch(() => {});
}
