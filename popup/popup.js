const ui = {
  loading: document.querySelector("#loading"),
  notYoutube: document.querySelector("#not-youtube"),
  panel: document.querySelector("#video-panel"),
  thumbnail: document.querySelector("#thumbnail"),
  title: document.querySelector("#title"),
  channel: document.querySelector("#channel"),
  error: document.querySelector("#error"),
  progress: document.querySelector("#progress"),
  addButton: document.querySelector("#add-button"),
  copyDebug: document.querySelector("#copy-debug"),
  downloadDebug: document.querySelector("#download-debug"),
  downloadDebugMuted: document.querySelector("#download-debug-muted"),
  clearProgress: document.querySelector("#clear-progress"),
  progressHeader: document.querySelector("#progress-header"),
  debugStatus: document.querySelector("#debug-status")
};

let activeTab;
let videoInfo;
let running = false;

init();

async function init() {
  activeTab = await getActiveTab();

  ui.copyDebug?.addEventListener("click", copyDebugLog);
  ui.downloadDebug?.addEventListener("click", downloadDebugLog);
  ui.downloadDebugMuted?.addEventListener("click", downloadDebugLog);
  ui.clearProgress?.addEventListener("click", clearProgressLog);
  ui.addButton?.addEventListener("click", startFlow);

  if (!activeTab?.url || !isYouTubeWatchUrl(activeTab.url)) {
    showOnly(ui.notYoutube);
    return;
  }

  try {
    const response = await getVideoInfoWithRetry();
    if (!response?.ok) throw new Error(response?.error || "動画情報の取得に失敗しました。");
    videoInfo = response.video;
    renderVideoInfo(videoInfo);
    await restoreProgress();
  } catch (error) {
    showPanelError("動画情報を取得できませんでした。YouTube ページを再読み込みしてからもう一度お試しください。");
    console.error(error);
  }
}

// コンテンツスクリプトの応答待ちで固まらないよう、executeScript でページから直接取得する。
async function getVideoInfoWithRetry() {
  // 1. DOM から基本情報（タイトル・チャンネル・URL・サムネイル）を取得する。
  const [domResult] = await chrome.scripting.executeScript({
    target: { tabId: activeTab.id },
    func: () => {
      const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
      const meta = (n) => document.querySelector(`meta[property="${n}"],meta[name="${n}"]`)?.content || "";
      const current = new URL(location.href);
      const videoId = current.searchParams.get("v") || "";
      const title = clean(
        document.querySelector("h1.ytd-watch-metadata yt-formatted-string")?.textContent ||
        document.querySelector("h1.title yt-formatted-string")?.textContent ||
        meta("og:title") || document.title.replace(/\s+-\s+YouTube$/, "")
      );
      const channelName = clean(
        document.querySelector("#owner #channel-name #text a")?.textContent ||
        document.querySelector("ytd-video-owner-renderer #channel-name #text")?.textContent ||
        document.querySelector("ytd-watch-metadata ytd-channel-name a")?.textContent ||
        document.querySelector('link[itemprop="name"]')?.getAttribute("content") || meta("author")
      );
      const hasTranscriptButton = [...document.querySelectorAll("button, tp-yt-paper-item, ytd-menu-service-item-renderer, yt-button-renderer")]
        .some((e) => /文字起こし|字幕|transcript|caption/i.test(clean(`${e.textContent || ""} ${e.getAttribute("aria-label") || ""}`)));
      return {
        videoId,
        title,
        channelName,
        url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : location.href,
        thumbnailUrl: videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : meta("og:image"),
        pageUrl: location.href,
        hasTranscriptButton
      };
    }
  });

  const info = domResult?.result;
  if (!info) throw new Error("動画情報をページから取得できませんでした。");

  // 2. 字幕の有無を MAIN world の ytInitialPlayerResponse から判定する。
  let hasCaptions = info.hasTranscriptButton;
  try {
    const [capResult] = await chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      world: "MAIN",
      func: () => {
        try {
          const tracks = window.ytInitialPlayerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
          return Array.isArray(tracks) && tracks.length > 0;
        } catch {
          return false;
        }
      }
    });
    if (capResult?.result) hasCaptions = true;
  } catch (error) {
    console.warn("caption check failed", error);
  }

  return { ok: true, video: { ...info, hasCaptions } };
}

// 進捗・デバッグログは storage.local を唯一の真実として描画する。
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes.flowStatus) return;
  const entries = changes.flowStatus.newValue || [];
  renderProgress(entries);
  const last = entries[entries.length - 1];
  if (last?.kind === "done" || last?.kind === "error") setBusy(false);
});

async function startFlow() {
  if (!videoInfo || running) return;

  if (!videoInfo.hasCaptions) {
    showError("字幕がないため追加できません");
    return;
  }

  ui.progress.replaceChildren();
  ui.error.hidden = true;
  setDebugStatus("");
  setBusy(true);

  try {
    const response = await chrome.runtime.sendMessage({
      type: "START_NOTEBOOKLM_FLOW",
      payload: videoInfo
    });
    if (!response?.ok) throw new Error(response?.error || "NotebookLM への追加に失敗しました。");
  } catch (error) {
    addProgressItem(error.message || "処理中にエラーが発生しました。", "error");
    setBusy(false);
  }
}

function renderVideoInfo(info) {
  showOnly(ui.panel);
  ui.thumbnail.src = info.thumbnailUrl || "";
  ui.thumbnail.alt = info.title ? `${info.title} のサムネイル` : "動画サムネイル";
  ui.title.textContent = info.title || "タイトルを取得できませんでした";
  ui.channel.textContent = info.channelName ? `チャンネル: ${info.channelName}` : "チャンネル名を取得できませんでした";

  if (!info.hasCaptions) {
    showError("字幕がないため追加できません");
    ui.addButton.disabled = true;
  }
}

function showPanelError(text) {
  showOnly(ui.panel);
  showError(text);
  ui.addButton.disabled = true;
}

function showError(text) {
  ui.error.hidden = false;
  ui.error.textContent = text;
}

function addProgressItem(text, kind = "info") {
  const item = document.createElement("li");
  item.textContent = text;
  item.dataset.kind = kind;
  ui.progress.append(item);
  ui.progress.scrollTop = ui.progress.scrollHeight;
  if (ui.progressHeader) ui.progressHeader.hidden = false;
}

async function restoreProgress() {
  const { flowStatus = [] } = await chrome.storage.local.get({ flowStatus: [] });
  renderProgress(flowStatus);
}

function renderProgress(entries) {
  ui.progress.replaceChildren();
  for (const entry of entries) addProgressItem(entry.text, entry.kind);
  if (ui.progressHeader) ui.progressHeader.hidden = entries.length === 0;
}

// 進捗ログ（および詳細ログ）を消去する。次回開いたときに古い履歴を表示しない。
async function clearProgressLog() {
  try {
    await chrome.storage.local.set({ flowStatus: [], debugLog: [] });
    ui.progress.replaceChildren();
    if (ui.progressHeader) ui.progressHeader.hidden = true;
    setDebugStatus("進捗ログを消去しました。");
  } catch (error) {
    setDebugStatus(error.message || "進捗ログの消去に失敗しました。");
  }
}

async function copyDebugLog() {
  const data = await getDebugPayload();
  try {
    await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
    setDebugStatus(`コピーしました（進捗 ${data.flowStatus.length} 件 / 詳細 ${data.debugLog.length} 件）`);
  } catch {
    setDebugStatus("コピーできませんでした。JSONファイル保存をご利用ください。");
  }
}

async function downloadDebugLog() {
  const data = await getDebugPayload();
  try {
    const response = await chrome.runtime.sendMessage({ type: "DOWNLOAD_DEBUG_LOG", payload: data });
    if (!response?.ok) throw new Error(response?.error || "JSONファイルを保存できませんでした。");
    setDebugStatus(`保存先を選ぶ画面を開きました（進捗 ${data.flowStatus.length} 件 / 詳細 ${data.debugLog.length} 件）`);
  } catch (error) {
    setDebugStatus(error.message || "JSONファイルを保存できませんでした。");
  }
}

async function getDebugPayload() {
  const data = await chrome.storage.local.get({ flowStatus: [], debugLog: [] });
  return {
    exportedAt: new Date().toISOString(),
    extension: "YouTube to NotebookLM Mind Map",
    page: {
      activeTabUrl: activeTab?.url || "",
      videoTitle: videoInfo?.title || "",
      channelName: videoInfo?.channelName || "",
      videoUrl: videoInfo?.url || ""
    },
    flowStatus: data.flowStatus,
    debugLog: data.debugLog
  };
}

function setDebugStatus(text) {
  if (ui.debugStatus) ui.debugStatus.textContent = text;
}

function setBusy(isBusy) {
  running = isBusy;
  ui.addButton.disabled = isBusy || !videoInfo?.hasCaptions;
  ui.addButton.textContent = isBusy ? "処理中..." : "NotebookLMに追加";
}

function showOnly(target) {
  [ui.loading, ui.notYoutube, ui.panel].forEach((el) => {
    if (el) el.hidden = el !== target;
  });
}

function isYouTubeWatchUrl(url) {
  try {
    const parsed = new URL(url);
    return /(^|\.)youtube\.com$/.test(parsed.hostname) && parsed.pathname === "/watch";
  } catch {
    return false;
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}
