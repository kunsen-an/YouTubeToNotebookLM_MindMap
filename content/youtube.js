// YouTube動画ページから動画情報を抽出するコンテンツスクリプト。
// ポップアップからの要求に応じて、タイトル・チャンネル名・URL・サムネイル・字幕有無を返す。

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "YT_GET_VIDEO_INFO") return false;

  try {
    sendResponse({ ok: true, video: getVideoInfo() });
  } catch (error) {
    sendResponse({ ok: false, error: error?.message || String(error) });
  }
  return true;
});

function getVideoInfo() {
  const url = canonicalVideoUrl();
  const videoId = new URL(url).searchParams.get("v") || "";

  return {
    videoId,
    title: getTitle(),
    channelName: getChannelName(),
    url,
    thumbnailUrl: videoId
      ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
      : getMeta("og:image"),
    hasCaptions: hasCaptions(),
    pageUrl: location.href
  };
}

function getTitle() {
  return cleanText(
    document.querySelector("h1.ytd-watch-metadata yt-formatted-string")?.textContent ||
      document.querySelector("h1.title yt-formatted-string")?.textContent ||
      getMeta("og:title") ||
      document.title.replace(/\s+-\s+YouTube$/, "")
  );
}

function getChannelName() {
  return cleanText(
    document.querySelector("#owner #channel-name #text a")?.textContent ||
      document.querySelector("ytd-video-owner-renderer #channel-name #text")?.textContent ||
      document.querySelector("ytd-watch-metadata ytd-channel-name a")?.textContent ||
      document.querySelector('link[itemprop="name"]')?.getAttribute("content") ||
      getPlayerResponse()?.videoDetails?.author ||
      getMeta("author")
  );
}

function canonicalVideoUrl() {
  const current = new URL(location.href);
  const videoId = current.searchParams.get("v");
  if (videoId) return `https://www.youtube.com/watch?v=${videoId}`;

  const canonical = document.querySelector('link[rel="canonical"]')?.href;
  if (canonical) return canonical;

  return location.href;
}

// 字幕の有無を判定する。ytInitialPlayerResponse の captionTracks を最優先で確認し、
// 取得できない場合は文字起こしボタンの存在で補完する。
function hasCaptions() {
  const playerResponse = getPlayerResponse();
  const tracks =
    playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (Array.isArray(tracks) && tracks.length > 0) return true;

  const transcriptControls = [
    ...document.querySelectorAll(
      "button, tp-yt-paper-item, ytd-menu-service-item-renderer, yt-button-renderer"
    )
  ];

  return transcriptControls.some((element) => {
    const text = cleanText(
      `${element.textContent || ""} ${element.getAttribute("aria-label") || ""}`
    );
    return /文字起こし|字幕|transcript|caption/i.test(text);
  });
}

function getPlayerResponse() {
  if (window.ytInitialPlayerResponse) return window.ytInitialPlayerResponse;

  for (const script of document.scripts) {
    const text = script.textContent || "";
    const marker = "ytInitialPlayerResponse = ";
    const start = text.indexOf(marker);
    if (start === -1) continue;

    const jsonStart = start + marker.length;
    let depth = 0;
    let end = -1;
    for (let i = jsonStart; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end === -1) continue;

    try {
      return JSON.parse(text.slice(jsonStart, end));
    } catch {
      return null;
    }
  }

  return null;
}

function getMeta(name) {
  return (
    document.querySelector(`meta[property="${name}"], meta[name="${name}"]`)
      ?.content || ""
  );
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}
