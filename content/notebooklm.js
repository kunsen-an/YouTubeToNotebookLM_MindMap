// NotebookLM の Web UI を自動操作するスクリプト。
// manifest の宣言済みコンテンツスクリプト（isolated world）として読み込まれる。
// 既存タブで未注入の場合は background.js が scripting でフォールバック注入する。
// background.js からの NLM_RUN_FLOW メッセージで一連のフローを実行する。
//
// フロー: ノートブックを開く/作成 → 名前設定 → YouTubeソース追加 → 追加確認 → マインドマップ起動
//
// UI文言は日本語・英語の両方を考慮し、DOM選択は aria-label / テキスト / クラスを併用して堅牢化する。

const NLM_VERSION = "1.2.1-runner";
const DELAY = 250;
const LONG_DELAY = 900;

// ---- 多言語ラベル定義 -------------------------------------------------------
const L = {
  createNotebook: ["ノートブックを新規作成", "新規作成", "新しいノートブック", "Create new notebook", "Create new", "New notebook", "Create"],
  addSource: ["ソースを追加", "ソース追加", "Add source", "Add sources", "Add a source"],
  // ソース種別「ウェブサイト」ボタン（YouTube URLはこの種別で追加する）。
  // 注意: 検索ボックス内の「ウェブ ▼」ドロップダウンと混同しないよう、「ウェブ」単体は含めない。
  websiteOption: ["ウェブサイト", "Website", "ウェブ サイト", "link"],
  urlInput: ["URL を入力", "URLを入力", "URL を貼り付け", "リンクを貼り付け", "Paste URL", "Enter URL", "URL", "リンク"],
  // 確定ボタン。検索の「送信」と区別するため優先語を分ける。
  insertPrimary: ["挿入", "追加", "Insert", "Add"],
  insert: ["挿入", "追加", "Insert", "Add", "送信", "Submit"],
  close: ["閉じる", "Close", "キャンセル", "Cancel", "Dismiss"],
  untitled: ["無題のノートブック", "Untitled notebook", "新しいノートブック", "Untitled"],
  studio: ["Studio", "スタジオ"],
  mindMap: ["マインドマップ", "Mind map", "Mind Map", "マインド マップ"],
  emptySources: ["保存したソースがここに表示", "保存したソースは", "ソースを追加] をクリック", "Saved sources will appear", "Add a source to get started", "click the [Add source"]
};

// ---- メッセージング ---------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "NLM_PING") {
    sendResponse({ ok: true, version: NLM_VERSION });
    return true;
  }

  // 対象ノートブックの状態を判定して background に返す（クリックによる遷移は background が行う）。
  if (message?.type === "NLM_RESOLVE") {
    resolveNotebook(message.payload?.channelName)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, action: "error", error: error?.message || String(error) }));
    return true;
  }

  if (message?.type !== "NLM_RUN_FLOW") return false;

  runFlow(message.payload)
    .then((result) => sendResponse({ ok: true, result }))
    .catch(async (error) => {
      await snapshot("error-final", { error: error?.message });
      status(decorateError(error?.message || "NotebookLM の操作に失敗しました。"), "error");
      sendResponse({ ok: false, error: error?.message || String(error) });
    });

  return true;
});

// ホーム画面または現在のノートブックを調べ、background に次の操作を指示する。
// クリックでのページ遷移はリロードでスクリプトが破棄されるため、ここでは遷移しない。
async function resolveNotebook(channelName) {
  await waitForDocumentReady();
  await waitUntilLoaded();
  const channel = (channelName || "").trim();
  if (!channel) return { action: "create" };

  if (isNotebookPage()) {
    const title = visibleNotebookTitle();
    if (isSameName(title, channel)) {
      await debug("resolve:already", { title });
      return { action: "already", foundName: title };
    }
    await debug("resolve:wrong-notebook", { title, channel });
    return { action: "gohome" };
  }

  const existing = findNotebookCard(channel);
  if (existing) {
    const anchor = existing.clickTarget.closest?.("a[href]") || existing.clickTarget.querySelector?.("a[href]") || existing.clickTarget;
    const url = (anchor && (anchor.href || anchor.getAttribute?.("href"))) || "";
    const foundName = existing.cardName || channel;
    await debug("resolve:open", { foundName, url });
    return { action: url ? "open" : "open-click", url: toAbsoluteUrl(url), foundName };
  }

  await debug("resolve:create", { channel });
  return { action: "create" };
}

function toAbsoluteUrl(url) {
  if (!url) return "";
  try {
    return new URL(url, location.origin).href;
  } catch {
    return url;
  }
}

// ---- メインフロー -----------------------------------------------------------
let currentContext = { channelName: "", videoUrl: "", openedNotebook: "" };

async function runFlow(payload) {
  // payload = { video, resolved }（旧形式の video 単体も一応許容）
  const video = payload?.video || payload;
  const resolved = payload?.resolved || { action: "create" };
  currentContext = { channelName: (video.channelName || "").trim(), videoUrl: video.url || "", openedNotebook: "" };
  await waitForDocumentReady();
  await debug("flow:start", { video, resolved, url: location.href });
  await snapshot("flow-start");

  const channel = currentContext.channelName;
  if (!channel) throw new Error("YouTubeチャンネル名が空のため、対象ノートブックを特定できません。");
  status(`対象YouTubeチャンネル名:「${channel}」`);

  await prepareNotebook(channel, resolved);

  await addYouTubeSource(video);
  await selectOnlyVideoSource(video);
  await startMindMap(video);

  status(`ノートブック「${currentContext.openedNotebook || channel}」でマインドマップの生成を開始しました`, "done");
  return { notebook: currentContext.openedNotebook || channel };
}

// ===========================================================================
//  ノートブックを用意する（background の解決結果に従う）
// ===========================================================================
async function prepareNotebook(name, resolved) {
  await waitUntilLoaded();
  await snapshot("after-load");

  const action = resolved?.action || "create";

  if (action === "create") {
    status(`チャンネル名「${name}」に一致する既存ノートブックが無いため、新規作成します`);
    await createNotebook(name);
    return;
  }

  if (action === "open-click") {
    // フォールバック: リンクURLが取得できなかった場合のみ、その場でクリックして開く。
    const existing = findNotebookCard(name);
    if (existing) {
      const foundName = existing.cardName || name;
      status(`既存ノートブック「${foundName}」を開いています`);
      const beforeUrl = location.href;
      await clickElement(existing.clickTarget);
      await waitForNotebookOpen(beforeUrl, foundName);
      currentContext.openedNotebook = visibleNotebookTitle() || foundName;
      status(`既存ノートブック「${currentContext.openedNotebook}」を開きました`);
      return;
    }
    // 見つからなければ作成にフォールバック
    await createNotebook(name);
    return;
  }

  // action === "already" / "open": background が既にノートブックページへ遷移済み。
  await waitForNotebookOpen("", resolved?.foundName || name).catch(() => {});
  currentContext.openedNotebook = visibleNotebookTitle() || resolved?.foundName || name;
  status(`ノートブック「${currentContext.openedNotebook}」を開きました`);
}

async function waitUntilLoaded() {
  await waitFor(() => (document.body?.innerText || "").trim().length > 0, 30000, "NotebookLM の画面を読み込めませんでした。");
  await wait(LONG_DELAY);
}

async function goHome() {
  const homeLink = findFirst([
    "a.logo-link",
    "a[aria-label*='NotebookLM']",
    "a[href='/']",
    "a[href='https://notebooklm.google.com/']"
  ]);
  if (homeLink) {
    await clickElement(homeLink);
  } else {
    location.assign("https://notebooklm.google.com/");
  }
  await waitFor(() => !isNotebookPage(), 15000).catch(() => {});
  await wait(LONG_DELAY);
}

// ホーム画面のノートブック一覧から、チャンネル名に一致するカードを探す。
function findNotebookCard(name) {
  const target = normalize(name);
  const cards = [...document.querySelectorAll("project-button, mat-card, [role='gridcell'], a[href*='/notebook/']")]
    .filter((el) => isVisible(el) && !isCreateCard(el));

  const scored = cards
    .map((card) => ({ card, cardName: notebookCardName(card) }))
    .filter((entry) => entry.cardName);

  // 1. 完全一致
  const exact = scored.filter((entry) => isSameName(entry.cardName, name));
  // 2. 接尾辞付き等（チャンネル名で始まる / 含む）
  const startsWith = scored.filter((entry) => normalize(entry.cardName).startsWith(target));
  const includes = scored.filter((entry) => normalize(entry.cardName).includes(target));

  const pick = exact[0] || startsWith[0] || includes[0];
  if (!pick) {
    debug("notebook:no-match", { targetName: name, candidates: scored.slice(0, 30).map((e) => e.cardName) });
    return null;
  }
  if (!exact[0]) {
    status(`チャンネル名「${name}」に部分一致するノートブック「${pick.cardName}」を既存として開きます`);
  }
  const clickTarget = clickableForCard(pick.card);
  return { card: pick.card, clickTarget, cardName: pick.cardName };
}

function isCreateCard(el) {
  const text = normalize(`${el.className || ""} ${el.textContent || ""} ${el.getAttribute("aria-label") || ""}`);
  return /create-new|新規作成|create new|新しいノートブック/.test(text);
}

function notebookCardName(card) {
  const titleEl = card.querySelector(
    ".project-button-title, [class*='title'], [class*='Title'], h1, h2, h3, [role='heading']"
  );
  let text = cleanText(titleEl?.textContent || "");
  if (!text) {
    // カード全体テキストから、件数やメタ情報を除いた先頭行を採用
    text = cleanText(card.textContent || "")
      .split(/\d+\s*個のソース|\d+\s*sources?|·|•|\n/i)[0];
  }
  return cleanText(text);
}

function clickableForCard(card) {
  return (
    card.closest("a[href*='/notebook/']") ||
    card.querySelector("a[href*='/notebook/'], button") ||
    card.closest("button, [role='button']") ||
    card
  );
}

// 新規ノートブックを作成し、名前をチャンネル名に設定する。
async function createNotebook(name) {
  await snapshot("before-create");
  const createButton = await waitFor(
    () => findCreateNotebookButton(),
    30000,
    `「新規作成」ボタンが見つかりませんでした。現在URL: ${location.href}`
  );
  await debug("create:button", summary(createButton));
  const beforeUrl = location.href;
  await clickElement(createButton);

  // 作成直後はノートブック画面（addSource ダイアログが自動で開く場合あり）へ遷移する。
  await waitForNotebookOpen(beforeUrl, name);
  await snapshot("after-create-open");

  // 名前をチャンネル名へ設定する。
  await renameNotebook(name);
  currentContext.openedNotebook = visibleNotebookTitle() || name;
  status(`ノートブック「${currentContext.openedNotebook}」を作成しました`);
}

function findCreateNotebookButton() {
  // aria-label 優先
  const byAria = [...document.querySelectorAll("button[aria-label], [role='button'][aria-label]")]
    .filter((el) => isVisible(el) && !isDisabled(el))
    .find((el) => matchesAny(el.getAttribute("aria-label"), L.createNotebook));
  if (byAria) return byAria;

  // 「新規作成」カード/ボタン
  const byText = findByText(L.createNotebook, "button, [role='button'], mat-card");
  if (byText) return byText;

  return null;
}

async function renameNotebook(name) {
  // タイトル入力欄が描画されるまで待つ（作成直後は未描画のことがある）。
  const titleInput = await waitFor(() => findTitleInput(), 15000, "").catch(() => null);
  if (!titleInput) {
    status(`ノートブック名入力欄が見つからないため、自動命名のままにします（目標名:「${name}」）`);
    await debug("rename:no-input", { inputs: collect("input, [contenteditable]", 10) });
    return;
  }

  const current = cleanText(titleInput.value || titleInput.textContent || "");
  if (isSameName(current, name)) {
    status(`ノートブック名はすでに「${current}」です`);
    return;
  }

  await fillInput(titleInput, name);
  // タイトルは Enter / blur で確定する
  pressEnter(titleInput);
  titleInput.blur?.();
  await wait(LONG_DELAY);
  await debug("rename:done", { target: name, after: cleanText(titleInput.value || titleInput.textContent || "") });
  status(`ノートブック名を「${name}」に設定しました`);
}

// タイトル入力欄（無題のノートブック等のデフォルト値を持つ input）を探す。
function findTitleInput() {
  // 1a. NotebookLM のタイトル入力欄は input.title-input。
  const titleInput = [...document.querySelectorAll("input.title-input, .title-input input, input[class*='title']")]
    .find((el) => isVisible(el) && !el.readOnly);
  if (titleInput) return titleInput;

  const inputs = [...document.querySelectorAll("input, [contenteditable='true']")].filter(
    (el) => isVisible(el) && !el.readOnly
  );

  // 1. 現在値がデフォルトの「無題のノートブック」等
  const byValue = inputs.find((el) => matchesAny(el.value || el.textContent, L.untitled));
  if (byValue) return byValue;

  // 2. aria-label がタイトル系
  const byAria = inputs.find((el) => /title|タイトル|名前|name/i.test(el.getAttribute("aria-label") || ""));
  if (byAria) return byAria;

  // 3. ヘッダー領域内の最初の input
  const header = document.querySelector("header, .notebook-header, [class*='header'], [class*='title']");
  if (header) {
    const headerInput = inputs.find((el) => header.contains(el));
    if (headerInput) return headerInput;
  }

  return null;
}

// ===========================================================================
//  YouTube ソースを追加する
// ===========================================================================
async function addYouTubeSource(video) {
  const url = video.url;
  await snapshot("before-add-source");
  status(`YouTube動画URLをソースとして追加します: ${url}`);

  // 追加前のソースタイトル一覧を記録しておく（後で「新規追加された行＝対象動画」を特定するため）。
  const panelBefore = findSourcePanel();
  currentContext.sourceTitlesBefore = panelBefore ? findSourceRows(panelBefore).map((r) => normalize(r.title)).filter(Boolean) : [];
  await debug("source:titles-before", currentContext.sourceTitlesBefore);

  const before = sourceListState();
  await debug("source:before", before);

  try {
    // 1. ソース追加ダイアログを開く（既に開いていれば再利用）
    if (!findSourceDialog()) {
      const addButton = await waitFor(
        () => findAddSourceButton(),
        45000,
        `「ソースを追加」ボタンが見つかりませんでした。現在URL: ${location.href}`
      );
      await debug("source:add-button", summary(addButton));
      await clickElement(addButton);
      await snapshot("after-add-source-click");
    } else {
      await debug("source:dialog-already-open", summary(findSourceDialog()));
    }

    // 2. URL入力欄を取得（必要ならウェブサイト/YouTube選択肢を押す）
    let urlInput = findUrlInput();
    if (!urlInput) {
      const option = await waitFor(
        () => findWebsiteOption(),
        30000,
        `YouTube/ウェブサイトのソース種別が見つかりませんでした。現在URL: ${location.href}`
      );
      await debug("source:website-option", summary(option));
      await clickElement(option);
      await snapshot("after-website-option");
      urlInput = await waitFor(
        () => findUrlInput(),
        30000,
        `URL入力欄が見つかりませんでした。現在URL: ${location.href}`
      );
    }
    await debug("source:url-input", summary(urlInput));

    // 3. URLを入力（Angularフォーム更新のため MAIN world 経由）
    const filled = await fillInput(urlInput, url);
    await snapshot("after-url-fill");
    if (!filled || readControlValue(urlInput) !== url) {
      throw new Error(`URLが入力欄に反映されませんでした。入力欄の現在値:「${readControlValue(urlInput) || "空"}」`);
    }
    status("URLを入力しました。確定ボタンを押します");

    // 4. 確定（挿入/追加）ボタンを押す
    pressEnter(urlInput);
    await wait(DELAY);
    const submit = await waitFor(
      () => findSubmitButton(),
      30000,
      `ソース追加の確定（挿入/追加）ボタンが見つかりませんでした。現在URL: ${location.href}`
    );
    await debug("source:submit-button", summary(submit));
    await clickElement(submit);
    await wait(1200);

    // 確定後もURL入力欄が残っていれば、もう一度確定を試す
    if (findUrlInput() && readControlValue(findUrlInput()) === url) {
      const retry = findSubmitButton();
      if (retry) {
        await debug("source:submit-retry", summary(retry));
        await clickElement(retry);
        await wait(1500);
      }
    }

    // 5. ソース一覧に追加されたことを確認する（最重要）
    status("ソース一覧への追加を確認しています");
    await waitForSourceAdded(video, before);
  } finally {
    await closeLingeringDialogs();
  }

  await snapshot("after-source-added");

  // インポート結果を確認する。NotebookLMはURLを一覧に出した後に取り込み処理を行い、
  // 成功すれば動画タイトルに解決され、失敗すれば「インポートできません」等を表示する。
  status("動画のインポート結果を確認しています");
  const outcome = await waitForImportOutcome(video);
  await debug("source:import-outcome", outcome);
  if (outcome.failed) {
    await snapshot("source-import-failed");
    throw new Error(
      `この動画はNotebookLMに取り込めませんでした：${outcome.failed}。` +
      `字幕／文字起こしを取得できない動画の可能性があります。別の動画でお試しください。` +
      `（NotebookLMに残った失敗ソースは手動で削除してください）`
    );
  }

  status(`動画「${outcome.title || video.title || ""}」のインポートが完了しました`);
}

// ソース追加後、インポートの成否（タイトル解決＝成功／エラー表示・行消滅＝失敗）を判定する。
async function waitForImportOutcome(video) {
  const videoId = safeVideoId(video.url).toLowerCase();
  const before = currentContext.sourceTitlesBefore || [];
  const start = Date.now();
  const timeout = 90000;

  while (Date.now() - start < timeout) {
    const err = findImportError();
    if (err) return { failed: err };

    // 追加で増えた行（新規ソース）を追跡する。タイトルが解決されると行テキストから
    // videoIdが消えるため、videoIdだけでなく「追加前に無かった行」でも追う。
    const target = findNewSourceRow(videoId, before);
    if (!target) {
      // 新規行が見当たらない＝取り込み失敗で削除された可能性
      if (Date.now() - start > 12000) return { failed: "ソースが一覧から消えました（インポート失敗の可能性）" };
    } else if (isResolvedTitle(target.title, videoId)) {
      return { ok: true, title: target.title };
    }
    await wait(1500);
  }

  // タイムアウト：タイトルが解決されないまま（URLのまま）＝取り込み未完了/失敗とみなす。
  const target = findNewSourceRow(videoId, before);
  return {
    failed: target ? "インポートが完了しませんでした（タイトルが解決されません）" : "インポート結果を確認できませんでした"
  };
}

// 追加した動画のソース行を探す。URL段階は videoId 一致で、解決後は「追加前に無かった新規行」で追う。
function findNewSourceRow(videoId, before) {
  const panel = findSourcePanel();
  if (!panel) return null;
  const rows = findSourceRows(panel);
  const byId = videoId ? rows.find((r) => r.text.includes(videoId)) : null;
  if (byId) return byId;
  const newRows = computeNewRows(rows, before);
  return newRows[0] || null;
}

// タイトルがURL以外（動画タイトル）に解決されているか。
function isResolvedTitle(title, videoId) {
  const t = normalize(title);
  if (!t) return false;
  return !t.includes(videoId) && !t.includes("youtube.com/watch") && !t.includes("youtu.be") && !/^https?:\/\//.test(t);
}

// インポート失敗を示すテキスト（トースト/ソースパネル/ダイアログ）を検出する。
function findImportError() {
  const pattern = /インポートできません|インポートに失敗|取り込めません|読み込めませんでした|対応していません|サポートされていません|処理できませんでした|字幕がありません|文字起こしを取得できません|couldn'?t import|failed to import|unable to import|not supported|no transcript|couldn'?t (?:fetch|read)/i;

  const scopes = [
    ...document.querySelectorAll(".mat-mdc-snack-bar-label, [role='alert'], simple-snack-bar, .mdc-snackbar__label, .cdk-overlay-pane, [role='dialog']"),
    findSourcePanel()
  ].filter((el) => el && isVisible(el));

  for (const scope of scopes) {
    const text = cleanText(scope.textContent);
    if (!pattern.test(text)) continue;
    // できるだけ短いエラー要素を取り出す
    const el = [...scope.querySelectorAll("*")]
      .filter((e) => isVisible(e))
      .map((e) => cleanText(e.textContent))
      .filter((x) => x && x.length < 140 && pattern.test(x))
      .sort((a, b) => a.length - b.length)[0];
    return (el || text).slice(0, 200);
  }
  return null;
}

function findAddSourceButton() {
  const byAria = [...document.querySelectorAll("button[aria-label], [role='button'][aria-label]")]
    .filter((el) => isVisible(el) && !isDisabled(el) && !isPanelToggle(el))
    .find((el) => matchesAny(el.getAttribute("aria-label"), L.addSource));
  if (byAria) return byAria;

  const byText = [...document.querySelectorAll("button, [role='button']")]
    .filter((el) => isVisible(el) && !isDisabled(el) && !isPanelToggle(el))
    .find((el) => matchesAny(el.textContent, L.addSource));
  return byText || null;
}

// パネルの開閉トグル（dock_to_right 等）を「ソースを追加」と誤認しないようにする。
function isPanelToggle(el) {
  const text = normalize(`${el.textContent || ""} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""}`);
  return /dock_to_|panel|パネル|ペイン|toggle|閉じる|展開|折りたた/.test(text);
}

function findSourceDialog() {
  // ソース追加ダイアログ特有の語を要求する。単に「ソース」を含むだけのツールチップ/パネルや
  // 無関係な cdk-overlay-pane を誤検出しないようにする。
  const marker = /ファイルをアップロード|ウェブサイト|コピーしたテキスト|URL を入力|URLを入力|から音声解説|drop files|upload a file|paste url|paste text|paste copied/i;

  // 1. まず実ダイアログ（role=dialog / mat-dialog-container）を優先する。
  const dialogs = [...document.querySelectorAll("[role='dialog'], mat-dialog-container, .mat-mdc-dialog-container")]
    .filter((el) => isVisible(el));
  const fromDialog = dialogs.reverse().find((el) => marker.test(el.textContent || ""));
  if (fromDialog) return fromDialog;

  // 2. フォールバック: cdk-overlay-pane でも、明確に追加ダイアログの内容を含むもののみ。
  const panes = [...document.querySelectorAll(".cdk-overlay-pane")].filter((el) => isVisible(el));
  return panes.reverse().find((el) => marker.test(el.textContent || "")) || null;
}

function dialogScopes() {
  const dialog = findSourceDialog();
  const scopes = [dialog, dialog?.closest(".cdk-overlay-pane"), document].filter(Boolean);
  return [...new Set(scopes)];
}

function findWebsiteOption() {
  const dialog = findSourceDialog() || document;
  const candidates = [...dialog.querySelectorAll("button, [role='button'], mat-card, .mat-mdc-card, mat-chip, [role='listitem']")]
    .filter((el) => isVisible(el) && !isDisabled(el))
    // 検索ボックス内の corpus 選択ドロップダウン（ウェブ ▼）等は除外する。
    .filter((el) => !isCorpusDropdown(el));

  // 1. 「ウェブサイト」テキスト/aria を最優先（YouTube URL はこの種別で追加する）。
  const byWebsite = candidates.find((el) =>
    matchesAny(`${el.textContent || ""} ${el.getAttribute("aria-label") || ""}`, ["ウェブサイト", "Website", "ウェブ サイト"])
  );
  if (byWebsite) return byWebsite;

  // 2. YouTube アイコン（video_youtube 等）を持つボタン。
  const byIcon = candidates.find((el) => {
    const icon = normalize(el.querySelector("mat-icon, .material-icons, [class*='icon']")?.textContent);
    return /youtube/.test(icon);
  });
  return byIcon || null;
}

// 検索ボックス内のコーパス選択ドロップダウン（「ウェブ ▼」など）を判定する。
function isCorpusDropdown(el) {
  const cls = normalize(el.className || "");
  if (/corpus-select|corpus-menu|menu-trigger/.test(cls)) return true;
  const text = normalize(`${el.textContent || ""}`);
  return /keyboard_arrow_down/.test(text);
}

function findUrlInput() {
  for (const scope of dialogScopes()) {
    const inputs = [...scope.querySelectorAll("input, textarea")]
      .filter((el) => isVisible(el) && !el.disabled && !el.readOnly && !isSearchInput(el));

    // aria-label / placeholder が URL 系
    const byLabel = inputs.find((el) => matchesAny(`${el.getAttribute("aria-label") || ""} ${el.getAttribute("placeholder") || ""}`, L.urlInput));
    if (byLabel) return byLabel;

    // type=url
    const byType = inputs.find((el) => (el.getAttribute("type") || "") === "url");
    if (byType) return byType;
  }
  return null;
}

// 検索/クエリ/チャット入力欄を URL欄と誤認しないようにする。
function isSearchInput(el) {
  const text = normalize(`${el.className || ""} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("placeholder") || ""}`);
  return /query|クエリ|検索|search|ソースを検出|detect|chat|チャット|質問|ask/.test(text);
}

function findSubmitButton() {
  const buttons = dialogScopes()
    .flatMap((scope) => [...scope.querySelectorAll("button, [role='button']")])
    .filter((el, i, arr) => arr.indexOf(el) === i)
    .filter((el) => isVisible(el) && isInsideDialog(el));

  const enabled = buttons.filter((el) => !isDisabled(el) && !isCorpusDropdown(el));
  const notCreate = (text) => !/ノートブック|notebook|作成|create/.test(text);

  // 1. 「挿入」「追加」「Insert」「Add」を最優先（検索の「送信」より先に判定）。
  const byPrimary = enabled.find((el) => {
    const text = normalize(`${el.textContent || ""} ${el.getAttribute("aria-label") || ""}`);
    return matchesAny(text, L.insertPrimary) && notCreate(text);
  });
  if (byPrimary) return byPrimary;

  // 2. その他の確定語（送信/Submit 等）。
  const byText = enabled.find((el) => {
    const text = normalize(`${el.textContent || ""} ${el.getAttribute("aria-label") || ""}`);
    return matchesAny(text, L.insert) && notCreate(text);
  });
  if (byText) return byText;

  // アイコンのみの確定ボタン
  const byIcon = enabled.find((el) => {
    const icon = normalize(el.querySelector("mat-icon, .material-icons, [class*='icon']")?.textContent);
    return /arrow_forward|east|check|done|send|add/.test(icon);
  });
  return byIcon || null;
}

function isInsideDialog(el) {
  const dialog = findSourceDialog();
  if (!dialog) return true;
  if (dialog.contains(el)) return true;
  // ダイアログの矩形近傍も許容
  const dr = dialog.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const m = 80;
  return r.left >= dr.left - m && r.right <= dr.right + m && r.top >= dr.top - m && r.bottom <= dr.bottom + m;
}

// ソース一覧に対象動画が追加されたことを確認する。
async function waitForSourceAdded(video, before) {
  const videoId = safeVideoId(video.url);
  const titleHint = normalize((video.title || "").slice(0, 24));

  await debug("source:wait-start", { before, videoId });

  await waitFor(
    () => {
      // エラートーストが出ていれば即座に失敗扱い
      const err = findErrorToast();
      if (err) throw new Error(`NotebookLM側でエラーが表示されました:「${err}」`);

      const now = sourceListState();
      if (now.empty) return false; // まだ空（プレースホルダ表示）

      const countIncreased = now.count > before.count;
      const text = now.text;
      const hasVideoId = videoId && text.includes(videoId.toLowerCase());
      const hasTitle = titleHint && text.includes(titleHint);
      const hasYouTube = /youtube|youtu\.be/.test(text);

      const processing = /処理中|読み込み中|追加しています|アップロード|processing|loading|adding/i.test(text);
      const populated = countIncreased || hasVideoId || hasTitle || (hasYouTube && now.count > 0);

      return populated && !processing;
    },
    90000,
    "ソース一覧にYouTube動画が追加されたことを確認できませんでした。"
  ).catch(async (error) => {
    await debug("source:wait-timeout", { error: error.message, state: sourceListState(), url: location.href });
    throw new Error(error.message);
  });

  await debug("source:wait-done", { state: sourceListState() });
  await wait(LONG_DELAY);
}

// ソースパネルの状態を取得する。空プレースホルダ表示を「追加済み」と誤判定しないことが重要。
function sourceListState() {
  const panel = findSourcePanel();
  if (!panel) return { count: 0, empty: true, text: "" };

  const text = normalize(panel.textContent);
  const empty = matchesAny(text, L.emptySources);

  const items = [
    ...panel.querySelectorAll(
      ".single-source, [class*='source-item'], [class*='source-list-item'], [class*='sourceItem'], mat-list-item, [role='listitem'], [class*='source-card']"
    )
  ].filter((el) => isVisible(el));

  let count = items.length
    ? new Set(items.map((el) => el.closest("li, mat-list-item, [class*='source'], [class*='item']") || el)).size
    : 0;

  if (count === 0 && !empty && /youtube|youtu\.be/.test(text)) count = 1;

  return { count: empty ? 0 : count, empty, text };
}

function findSourcePanel() {
  const dialog = findSourceDialog();
  const candidates = [...document.querySelectorAll("section.source-panel, [class*='source-panel'], aside, mat-sidenav, section")]
    .filter((el) => isVisible(el) && !dialog?.contains(el))
    .filter((el) => /ソース|sources?/i.test(el.textContent || ""));

  // 画面左側で背の高いものを優先
  return (
    candidates.sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return ar.left - br.left || br.height - ar.height;
    })[0] || null
  );
}

function findErrorToast() {
  const toasts = [...document.querySelectorAll(".mat-mdc-snack-bar-label, [role='alert'], simple-snack-bar, .mdc-snackbar__label, [class*='error']")]
    .filter((el) => isVisible(el));
  for (const t of toasts) {
    const text = cleanText(t.textContent);
    if (text && /エラー|失敗|できません|無効|error|fail|invalid|unable|couldn|sorry/i.test(text)) {
      return text.slice(0, 200);
    }
  }
  return null;
}

// 残っているソース系ダイアログを閉じる（重なったパネルを残さない）。
async function closeLingeringDialogs() {
  for (let i = 0; i < 5; i += 1) {
    const dialog = findSourceDialog();
    if (!dialog) return;
    const closeButton = findCloseButton(dialog);
    if (!closeButton) {
      await debug("source:close-no-button", summary(dialog));
      return;
    }
    await debug("source:close", summary(closeButton));
    await clickElement(closeButton);
    await wait(600);
  }
}

function findCloseButton(dialog) {
  const buttons = [...dialog.querySelectorAll("button, [role='button']")].filter((el) => isVisible(el) && !isDisabled(el));
  return (
    buttons.find((el) => {
      const text = normalize(`${el.textContent || ""} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""}`);
      const icon = normalize(el.querySelector("mat-icon, .material-icons")?.textContent);
      return matchesAny(text, L.close) || icon === "close";
    }) || null
  );
}

// ===========================================================================
//  マインドマップの対象ソースを、追加した動画のみに絞る
// ===========================================================================
async function selectOnlyVideoSource(video) {
  status("マインドマップの対象を、追加した動画のみに設定します");
  const panel = findSourcePanel();
  if (!panel) {
    status("ソースパネルが見つからないため、ソース選択の調整をスキップします");
    return;
  }

  const rows = findSourceRows(panel);
  if (rows.length === 0) {
    status("個別のソース項目を検出できなかったため、選択調整をスキップします");
    await debug("select:no-rows", { panel: summary(panel) });
    return;
  }

  const videoId = safeVideoId(video.url);
  const titleHint = normalize((video.title || "").slice(0, 24));
  const url = normalize(video.url);
  const before = currentContext.sourceTitlesBefore || [];

  // 対象 = 追加前の在庫を超えて増えた行（＝今回新規に追加された動画）。
  // 多重集合の差分で判定するため、同名の動画が既に存在していても新規分だけを正しく選べる。
  const targetSet = new Set(computeNewRows(rows, before));

  // フォールバック: 差分が取れない場合は videoID / URL / タイトル一致で判定。
  if (targetSet.size === 0) {
    for (const r of rows) {
      const t = normalize(r.title);
      if (
        (videoId && r.text.includes(videoId.toLowerCase())) ||
        (url && r.text.includes(url)) ||
        (titleHint && titleHint.length > 8 && (t === titleHint || r.text.includes(titleHint)))
      ) {
        targetSet.add(r);
      }
    }
  }

  const isTarget = (r) => targetSet.has(r);
  const targets = rows.filter(isTarget);
  await debug("select:rows", { before, rows: rows.map((r) => ({ title: r.title, isTarget: isTarget(r) })) });
  if (targets.length === 0) {
    status("追加した動画のソースを特定できなかったため、全ソースが対象のままになります");
    await debug("select:target-not-found", { videoId, titleHint, before, rows: rows.map((r) => r.title) });
    return;
  }

  // まず「すべて選択」で全ソースの選択を一括解除する（個別トグルより速く確実）。
  const cleared = await clearAllSelectionsViaMaster();
  await debug("select:clear-all", { cleared });
  if (cleared) status("いったん全ソースの選択を解除しました");

  // チェックボックスはホバーで出現するため、各行をホバーしてからチェック状態を調整する。
  // 一括解除できていれば対象をONにするだけ、できていなければここで対象ON・他OFFを行う。
  let adjusted = 0;
  const report = [];
  for (const row of rows) {
    const want = isTarget(row);
    const result = await setRowSelected(row, want);
    report.push({ title: row.title, want, ...result });
    if (result.status === "toggled") adjusted += 1;
  }

  await debug("select:done", { targets: targets.map((t) => t.title), adjusted, report });
  if (report.every((r) => r.status === "no-checkbox")) {
    status("ソースの選択チェックボックスを検出できませんでした。全ソースが対象のまま生成される可能性があります。", "info");
  } else if (report.some((r) => r.status === "failed")) {
    status("一部ソースの選択切り替えが反映されませんでした。全ソースが対象になる場合があります。", "info");
  } else {
    status(`マインドマップ対象を「${targets[0].title || "追加した動画"}」のみに設定しました`);
  }
}

// ソースパネル内の各ソース行を取得する。
function findSourceRows(panel) {
  const stretched = [...panel.querySelectorAll(".source-stretched-button, [class*='source-stretched']")]
    .filter((el) => isVisible(el));

  const rows = [];
  for (const btn of stretched) {
    // タイトル・more_vert を含む行コンテナまで遡る
    let row = btn;
    for (let i = 0; i < 4; i += 1) {
      if (!row.parentElement) break;
      row = row.parentElement;
      if (row.querySelector(".source-item-more-button, [class*='more-button'], [class*='source-item']")) break;
    }
    const aria = btn.getAttribute("aria-label") || "";
    const titleEl = row.querySelector(".source-title, [class*='source-title']");
    const title = cleanText(titleEl?.textContent || aria).slice(0, 80);
    rows.push({ row, btn, title, text: normalize(`${aria} ${title} ${row.textContent}`) });
  }

  // 重複行を除去
  return rows.filter((r, i) => rows.findIndex((o) => o.row === r.row) === i);
}

// 「すべて選択」チェックボックスを使って、全ソースの選択を一括解除する。
// 見つからない／効かない場合は false を返し、呼び出し側が個別トグルでフォールバックする。
async function clearAllSelectionsViaMaster() {
  const master = findSelectAllCheckbox();
  if (!master) {
    await debug("select:no-master");
    return false;
  }

  const needClear = () => {
    if (master.input) return master.input.checked || master.input.indeterminate;
    const aria = master.container?.getAttribute("aria-checked");
    if (aria != null) return aria === "true" || aria === "mixed";
    return /mdc-checkbox--selected|checked|selected|indeterminate/.test(master.container?.className || "");
  };

  // チェック/部分チェックなら、クリックして全解除（最大3回）。
  for (let i = 0; i < 3 && needClear(); i += 1) {
    if (master.input && typeof master.input.click === "function") {
      master.input.focus?.();
      master.input.click();
    } else if (master.container) {
      await clickElement(master.container);
    }
    await wait(450);
  }

  await debug("select:master-after", { stillSelected: needClear(), master: summary(master.container || master.input) });
  return !needClear();
}

// 「すべて選択」(Select all) のチェックボックスを探す。
function findSelectAllCheckbox() {
  const panel = findSourcePanel();
  if (!panel) return null;

  // "すべて選択" / "Select all" のラベル要素（末端のテキストノードを持つもの）。
  const label = [...panel.querySelectorAll("*")]
    .find((el) => el.children.length === 0 && /^(すべて選択|select all)$/i.test(cleanText(el.textContent)));
  if (!label) return null;

  // ラベルの祖先をたどり、近傍のチェックボックスを探す。
  let node = label;
  for (let i = 0; i < 5 && node && node !== panel; i += 1) {
    const input = node.querySelector?.("input[type='checkbox']");
    if (input) return { input, container: node };
    const cb = node.querySelector?.(".select-checkbox-container, mat-checkbox, [role='checkbox'], [class*='checkbox']");
    if (cb) return { input: cb.querySelector?.("input[type='checkbox']") || null, container: cb };
    node = node.parentElement;
  }
  // ラベル自体をクリック対象として返す（label クリックで連動する場合がある）。
  return { input: null, container: label.closest("label, button, [role='checkbox'], div") || label };
}

// 追加前のタイトル一覧（多重集合）と比較し、在庫を超えて増えた行＝新規追加分を返す。
function computeNewRows(rows, beforeTitles) {
  const remaining = {};
  for (const t of beforeTitles) remaining[t] = (remaining[t] || 0) + 1;

  const newRows = [];
  for (const r of rows) {
    const t = normalize(r.title);
    if (remaining[t] > 0) {
      remaining[t] -= 1; // 既存分として消費
    } else {
      newRows.push(r); // 在庫を超えた＝今回追加された行
    }
  }
  return newRows;
}

// 1つのソース行を選択/非選択に設定する。
// NotebookLM のソース選択チェックボックス（input[type=checkbox]）はホバー時に描画されるため、
// 行および祖先にホバーイベントを発火して input を出現させ、ネイティブクリックで切り替える。
async function setRowSelected(item, want) {
  const input = await revealRowCheckboxInput(item);
  if (!input) {
    await debug("select:row-no-checkbox", {
      title: item.title,
      rowHtml: (item.row.outerHTML || item.row.innerHTML || "").slice(0, 1200)
    });
    return { status: "no-checkbox" };
  }

  const before = input.checked;
  if (before === want) return { status: "unchanged", was: before };

  // 最大4回まで input をネイティブクリックして切り替える（毎回ホバーを再発火して維持）。
  for (let attempt = 0; attempt < 4 && input.checked !== want; attempt += 1) {
    hoverRow(item);
    await wait(60);
    input.focus?.();
    input.click();
    // クリック対象が反映されない実装に備え、ラベル/コンテナのクリックも併用
    const label = input.closest("label") || input.closest(".mdc-checkbox, mat-checkbox, .select-checkbox-container");
    if (label && input.checked !== want) {
      label.click?.();
    }
    await wait(300);
  }

  const now = input.checked;
  await debug("select:toggle", { title: item.title, want, before, now, input: summary(input) });
  return { status: now === want ? "toggled" : "failed", was: before, now };
}

// ホバーで出現するチェックボックスの input を、出現するまでポーリングして取得する。
async function revealRowCheckboxInput(item) {
  for (let i = 0; i < 10; i += 1) {
    hoverRow(item);
    const input =
      item.row.querySelector("input[type='checkbox']") ||
      // 可視のチェックボックスコンテナ配下の input を優先
      [...item.row.querySelectorAll(".select-checkbox-container, [class*='select-checkbox'], mat-checkbox, .mdc-checkbox")]
        .map((c) => c.querySelector("input[type='checkbox']"))
        .find(Boolean) ||
      null;
    if (input) return input;
    await wait(200);
  }
  return null;
}

// 行とその祖先・主要子要素にホバーイベントを発火する（Angular の (mouseenter) を確実に起動）。
function hoverRow(item) {
  const targets = new Set();
  let el = item.row;
  for (let i = 0; i < 3 && el; i += 1) {
    targets.add(el);
    el = el.parentElement;
  }
  if (item.btn) targets.add(item.btn);
  const sourceItem = item.row.closest("[class*='source-item'], [class*='single-source']");
  if (sourceItem) targets.add(sourceItem);
  for (const t of targets) hoverElement(t);
}

function hoverElement(el) {
  if (!el) return;
  const r = el.getBoundingClientRect();
  const o = { bubbles: true, cancelable: true, composed: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  el.dispatchEvent(new PointerEvent("pointerover", o));
  el.dispatchEvent(new PointerEvent("pointerenter", o));
  el.dispatchEvent(new MouseEvent("mouseover", o));
  el.dispatchEvent(new MouseEvent("mouseenter", o));
  el.dispatchEvent(new MouseEvent("mousemove", o));
}

// ===========================================================================
//  Studio マインドマップを起動する
// ===========================================================================
async function startMindMap(video) {
  await snapshot("before-mind-map");
  status("Studioのマインドマップ機能を起動します");

  await ensureStudioOpen();

  // 既存のアーティファクト（前回のマインドマップ等）が開いていると、カード一覧が隠れている。
  // 「戻る/アプリビューアを閉じる」でカード一覧へ戻ってから「マインドマップ」カードを押す。
  let card = findMindMapControl();
  for (let i = 0; i < 4 && (isArtifactOpen() || !card); i += 1) {
    const back = findStudioBackButton();
    if (!back) break;
    await debug("mindmap:back-to-cards", { attempt: i + 1, button: summary(back), artifactOpen: isArtifactOpen() });
    status("開いているアーティファクト表示を閉じて、Studioのカード一覧へ戻ります");
    await clickElement(back);
    await wait(LONG_DELAY);
    card = findMindMapControl();
  }

  if (!card) {
    card = await waitFor(
      () => findMindMapControl(),
      30000,
      `Studioの「マインドマップ」が見つかりませんでした。現在URL: ${location.href}`
    ).catch(async (error) => {
      await snapshot("mind-map-not-found");
      await debug("mindmap:clickables", collect("button, [role='button'], div[aria-label], mat-card", 80));
      throw new Error(error.message);
    });
  }

  // 生成前のマインドマップ・アーティファクト件数を記録しておく（完了検出に使う）。
  currentContext.mindMapCountBefore = findMindMapArtifactRows().length;
  await debug("mindmap:count-before", { count: currentContext.mindMapCountBefore });

  // 「カスタマイズ」から日本語指定で生成する。カスタマイズが使えない場合はカードを直接クリック。
  let launched = await launchMindMapInJapanese(card);

  // 生成が始まらなければ（＝既存マップが開いただけ）、再生成を試みる。
  if (!launched) {
    const regen = findRegenerateButton();
    if (regen) {
      status("既存のマインドマップを、選択中のソースで再生成します");
      await debug("mindmap:regenerate", summary(regen));
      await clickElement(regen);
      await wait(LONG_DELAY);
      await confirmRegenerateDialog();
      launched = await confirmGenerating(45000);
    } else {
      await debug("mindmap:no-regenerate-button", collect("button, [role='button'], div[aria-label]", 80));
    }
  }

  await snapshot("after-mind-map-launch");
  if (!launched) {
    status("マインドマップのクリックは完了しましたが、生成開始の確定確認ができませんでした。すでに最新のマインドマップが表示されている可能性があります。NotebookLM画面をご確認ください。", "info");
    return;
  }
  status("マインドマップの生成が開始されました");

  // 生成完了後に、マインドマップの名前を動画名に変更する（可能な範囲で）。
  await renameArtifactToTitle(video);
}

const JP_PROMPT = "出力は必ず日本語で作成してください。各ノードの見出しも日本語にしてください。";

// 「マインドマップをカスタマイズ」から日本語指定で生成を試みる。
// 失敗時はカードを直接クリックして通常生成にフォールバックする。
async function launchMindMapInJapanese(card) {
  const customize = findMindMapCustomizeButton();
  if (customize) {
    await debug("mindmap:customize-button", summary(customize));
    status("「マインドマップをカスタマイズ」から日本語で生成します");
    await clickElement(customize);
    await wait(LONG_DELAY);
    await snapshot("after-customize-open");

    const promptInput = await waitFor(() => findCustomizePromptInput(), 6000, "").catch(() => null);
    if (promptInput) {
      await fillInput(promptInput, JP_PROMPT);
      await debug("mindmap:customize-prompt-filled", { value: readControlValue(promptInput) });
      status("日本語で作成するよう指示を入力しました");

      const genButton = await waitFor(() => findCustomizeGenerateButton(), 8000, "").catch(() => null);
      if (genButton) {
        await debug("mindmap:customize-generate", summary(genButton));
        // 「生成」は一度だけ押す。再クリックすると二重生成になるため繰り返さない。
        await clickElement(genButton);
        await waitFor(() => !findCustomizeDialog(), 10000).catch(() => {});
        // ダイアログが残っていても「生成」は押し直さず、×で閉じるだけにする。
        await closeCustomizeDialog();
        await confirmGenerating(15000);
        // 生成ボタンを押したので、確実に生成済みとして扱う（フォールバック生成を避ける）。
        return true;
      }
      // 生成ボタンが無い場合のみフォールバックへ。
      await debug("mindmap:customize-no-generate", collect("button, [role='button']", 40));
      await closeCustomizeDialog();
    } else {
      await debug("mindmap:customize-no-input", collect("input, textarea", 20));
      status("カスタマイズの入力欄が見つからなかったため、通常のマインドマップ生成を行います", "info");
      await closeCustomizeDialog();
    }
  }

  // フォールバック: カードを直接クリック
  await debug("mindmap:card", summary(card));
  await clickElement(card);
  await wait(LONG_DELAY);
  await snapshot("after-mind-map-click");
  return confirmGenerating(8000);
}

// 「マインドマップをカスタマイズ」ボタン（aria に「マインドマップ」と「カスタマイズ」を含む）。
function findMindMapCustomizeButton() {
  return (
    [...document.querySelectorAll("[aria-label]")]
      .filter((el) => isVisible(el) && !isDisabled(el))
      .find((el) => {
        const aria = normalize(el.getAttribute("aria-label"));
        return matchesAny(aria, L.mindMap) && /カスタマイズ|customize/.test(aria);
      }) || null
  );
}

// 「マインドマップをカスタマイズ」ダイアログ本体を探す。
function findCustomizeDialog() {
  const overlays = [...document.querySelectorAll("[role='dialog'], mat-dialog-container, .mat-mdc-dialog-container, .cdk-overlay-pane")]
    .filter((el) => isVisible(el));
  return (
    overlays.reverse().find((el) => /カスタマイズ|customize|希望するトピック|topic/i.test(el.textContent || "")) || null
  );
}

// カスタマイズダイアログ内のプロンプト入力欄（チャット/検索欄は除外）。
function findCustomizePromptInput() {
  const dialog = findCustomizeDialog();
  if (!dialog) return null;
  return (
    [...dialog.querySelectorAll("textarea, input[type='text'], [contenteditable='true']")]
      .filter((el) => isVisible(el) && !el.disabled && !el.readOnly && !isSearchInput(el))[0] || null
  );
}

// カスタマイズダイアログ内の生成ボタン（class=generate-button を優先）。
function findCustomizeGenerateButton() {
  const dialog = findCustomizeDialog();
  const scope = dialog || document;
  const buttons = [...scope.querySelectorAll("button, [role='button']")]
    .filter((el) => isVisible(el) && !isDisabled(el));
  return (
    buttons.find((el) => String(el.className || "").includes("generate-button")) ||
    buttons.find((el) => matchesAny(`${el.textContent || ""} ${el.getAttribute("aria-label") || ""}`, ["生成", "作成", "Generate", "Create"])) ||
    null
  );
}

// カスタマイズダイアログが残っていれば閉じる（× / 閉じる）。
async function closeCustomizeDialog() {
  const dialog = findCustomizeDialog();
  if (!dialog) return;
  const closeButton = findCloseButton(dialog) ||
    [...dialog.querySelectorAll("button, [role='button']")]
      .filter((el) => isVisible(el) && !isDisabled(el))
      .find((el) => normalize(el.querySelector("mat-icon, .material-icons")?.textContent) === "close" ||
        matchesAny(el.getAttribute("aria-label"), L.close));
  if (closeButton) {
    await debug("mindmap:customize-close", summary(closeButton));
    await clickElement(closeButton);
    await wait(500);
  }
}

// 生成完了後、マインドマップ（アーティファクト）の名前を動画タイトルに変更する。
async function renameArtifactToTitle(video) {
  const title = cleanText(video.title || "");
  if (!title) return;

  // 生成完了（Studio一覧に新しいマインドマップが出現）を検出してから改名する。
  status("マインドマップの生成完了を待って、名前を動画名に設定します");
  await waitForMindMapDone();
  await wait(DELAY);

  const target = findNewestMindMapArtifact();
  await debug("mindmap:rename-target", { found: Boolean(target), row: target ? summary(target.row) : null });

  // 1. Studio一覧の3点メニュー「名前を変更」で改名を試みる。
  let ok = await renameViaMenu(target, title);

  // 2. だめなら、アーティファクトを開いてタイトル入力欄を直接編集する。
  if (!ok) ok = await renameViaOpen(target, title);

  if (ok) status(`マインドマップ名を「${title}」に設定しました`);
  else {
    await debug("mindmap:rename-failed", { artifactOpen: isArtifactOpen(), studio: collect("button, a, [class*='artifact'], [role='menuitem']", 50) });
    status("マインドマップ名の自動設定はできませんでした（手動で変更してください）", "info");
  }
}

// 3点メニュー「名前を変更」経由で改名する。
async function renameViaMenu(target, title) {
  if (!target?.moreBtn) return false;
  await clickElement(target.moreBtn);
  await wait(LONG_DELAY);
  await snapshot("after-artifact-menu");

  const renameItem = findMenuItem(["名前を変更", "名前の変更", "タイトルを変更", "Rename", "Rename mind map"]);
  if (!renameItem) {
    await debug("mindmap:rename-no-menu-item", { menu: collect("[role='menuitem'], .mat-mdc-menu-item, button", 30) });
    pressEscape(document.body);
    return false;
  }
  await clickElement(renameItem);
  await wait(LONG_DELAY);

  const input = findRenameInput();
  if (!input) {
    await debug("mindmap:rename-no-field", { inputs: collect("input, textarea, [contenteditable='true']", 20) });
    return false;
  }
  const okFill = await fillInput(input, title);
  pressEnter(input);
  // 確定ボタンがあれば押す
  const confirm = findRenameConfirmButton();
  if (confirm) await clickElement(confirm);
  else input.blur?.();
  await wait(LONG_DELAY);

  const after = readControlValue(input);
  await debug("mindmap:rename-via-menu", { okFill, after, title });
  return okFill || titleMatches(after, title);
}

// アーティファクトを開いてタイトル入力欄を直接編集する。
async function renameViaOpen(target, title) {
  if (!isArtifactOpen()) {
    const openBtn = target?.openBtn || target?.row;
    if (openBtn) {
      await debug("mindmap:open-newest", summary(openBtn));
      await clickElement(openBtn);
      await waitFor(() => isArtifactOpen(), 15000).catch(() => {});
      await wait(LONG_DELAY);
    }
  }

  const input = document.querySelector("input.artifact-title, .artifact-title");
  if (!input || !isVisible(input)) {
    await debug("mindmap:rename-no-input", { artifactOpen: isArtifactOpen() });
    return false;
  }
  const current = cleanText(input.value || input.textContent || "");
  if (titleMatches(current, title)) return true;

  const okFill = await fillInput(input, title);
  pressEnter(input);
  input.blur?.();
  await wait(DELAY);
  await debug("mindmap:rename-via-open", { from: current, after: readControlValue(input), title });
  return okFill && titleMatches(readControlValue(input), title);
}

function titleMatches(a, b) {
  const x = normalize(a);
  const y = normalize(b);
  return Boolean(x) && (x === y || x.includes(y) || y.includes(x));
}

// Studioのアーティファクト一覧から、生成済みマインドマップ行の一覧を返す（上が新しい）。
// 各生成アーティファクトは .artifact-more-button（3点メニュー）を持つため、それを起点にする。
function findMindMapArtifactRows() {
  const moreButtons = [...document.querySelectorAll(".artifact-more-button, [class*='artifact-more']")]
    .filter((el) => isVisible(el));

  const rows = [];
  for (const moreBtn of moreButtons) {
    // 行コンテナ（stretched-button を含む祖先）まで遡る
    let row = moreBtn;
    for (let i = 0; i < 5 && row; i += 1) {
      row = row.parentElement;
      if (row?.querySelector(".artifact-stretched-button, [class*='artifact-stretched']")) break;
    }
    if (!row) continue;
    const text = cleanText(row.textContent);
    if (!/マインドマップ|mind ?map/i.test(text)) continue; // マインドマップ以外（音声解説等）は除外
    rows.push({
      row,
      moreBtn,
      openBtn: row.querySelector(".artifact-stretched-button, [class*='artifact-stretched']"),
      text,
      top: row.getBoundingClientRect().top
    });
  }

  return rows.sort((a, b) => a.top - b.top); // 上が最新
}

// 最新（最上段）のマインドマップ行。
function findNewestMindMapArtifact() {
  return findMindMapArtifactRows()[0] || null;
}

// マインドマップの生成完了を、Studio一覧への新規アーティファクト出現で検出する。
// （本文テキストやスピナーは誤検出しやすいため使わない）
async function waitForMindMapDone() {
  const before = currentContext.mindMapCountBefore || 0;
  const generating = /生成中|作成中|処理中|生成しています|作成しています|generating|creating/i;

  const done = await waitFor(() => {
    const rows = findMindMapArtifactRows();
    if (rows.length <= before) return false; // まだ新規アーティファクトが出ていない
    // 新規行が「生成中/作成中」表記でなければ完了とみなす（出現＝ほぼ完了）。
    return !generating.test(rows[0].text);
  }, 150000, "").then(() => true).catch(() => false);

  await debug("mindmap:done-detect", { before, after: findMindMapArtifactRows().length, done });
  return done;
}

// 開いているメニュー（mat-menu/overlay）から指定テキストの項目を探す。
function findMenuItem(labels) {
  const menus = [...document.querySelectorAll(".cdk-overlay-pane, [role='menu'], mat-menu, .mat-mdc-menu-panel")]
    .filter((el) => isVisible(el));
  const scope = menus.length ? menus : [document];
  for (const root of scope) {
    const items = [...root.querySelectorAll("[role='menuitem'], .mat-mdc-menu-item, button, [role='menuitemradio']")]
      .filter((el) => isVisible(el) && !isDisabled(el));
    const hit = items.find((el) => matchesAny(`${el.textContent || ""} ${el.getAttribute("aria-label") || ""}`, labels));
    if (hit) return hit;
  }
  return null;
}

// 「名前を変更」後に出る改名用の入力欄を探す（チャット/検索欄は除外）。
function findRenameInput() {
  // ダイアログ/オーバーレイ内、または編集可能になったタイトル欄
  const overlays = [...document.querySelectorAll("[role='dialog'], mat-dialog-container, .mat-mdc-dialog-container, .cdk-overlay-pane")]
    .filter((el) => isVisible(el));
  for (const root of overlays) {
    const input = [...root.querySelectorAll("input, textarea, [contenteditable='true']")]
      .find((el) => isVisible(el) && !el.disabled && !el.readOnly && !isSearchInput(el));
    if (input) return input;
  }
  // インライン編集（artifact-title が編集可能になる場合）
  const titleInput = document.querySelector("input.artifact-title, .artifact-title");
  if (titleInput && isVisible(titleInput) && !titleInput.readOnly) return titleInput;
  return null;
}

function findRenameConfirmButton() {
  const overlays = [...document.querySelectorAll("[role='dialog'], mat-dialog-container, .mat-mdc-dialog-container, .cdk-overlay-pane")]
    .filter((el) => isVisible(el));
  for (const root of overlays) {
    const btn = [...root.querySelectorAll("button, [role='button']")]
      .filter((el) => isVisible(el) && !isDisabled(el))
      .find((el) => matchesAny(`${el.textContent || ""} ${el.getAttribute("aria-label") || ""}`, ["名前を変更", "変更", "保存", "完了", "OK", "Rename", "Save", "Done"]));
    if (btn) return btn;
  }
  return null;
}

function pressEscape(element) {
  const opts = { bubbles: true, cancelable: true, key: "Escape", code: "Escape", keyCode: 27, which: 27 };
  (element || document.body).dispatchEvent(new KeyboardEvent("keydown", opts));
  (element || document.body).dispatchEvent(new KeyboardEvent("keyup", opts));
}

// Studioパネルが閉じている場合に開く。
async function ensureStudioOpen() {
  // すでにStudioの内容（カード or マインドマップ）が見えていれば何もしない。
  if (findMindMapControl() || findStudioBackButton() || isMindMapView()) return;

  const toggle = findStudioToggle();
  if (toggle) {
    await debug("mindmap:studio-toggle", summary(toggle));
    await clickElement(toggle);
    await wait(LONG_DELAY);
    await snapshot("after-studio-open");
  }
}

function findStudioToggle() {
  return (
    [...document.querySelectorAll("button, [role='button']")]
      .filter((el) => isVisible(el) && !isDisabled(el))
      .find((el) => {
        const text = normalize(`${el.textContent || ""} ${el.getAttribute("aria-label") || ""}`);
        return matchesAny(text, L.studio) && !/閉じる|close|dock_to_left|パネルを閉じ/.test(text);
      }) || null
  );
}

// アーティファクト（マインドマップ等）表示を閉じてカード一覧へ戻るボタン。
// NotebookLM では「アプリビューアを閉じる」(collapse_content) や 戻る(arrow_back) が該当する。
function findStudioBackButton() {
  const midX = window.innerWidth / 2;
  const candidates = [...document.querySelectorAll("button, [role='button']")]
    .filter((el) => isVisible(el) && !isDisabled(el))
    .filter((el) => {
      const text = normalize(`${el.textContent || ""} ${el.getAttribute("aria-label") || ""}`);
      const icon = normalize(el.querySelector("mat-icon, .material-icons")?.textContent);
      return /アプリビューア|アプリを閉じ|^戻る$|arrow_back|chevron_left|collapse_content/.test(text) ||
        ["arrow_back", "chevron_left", "collapse_content"].includes(icon);
    });
  // 右半分（Studio側）にあるものを優先
  return candidates.sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left)
    .find((el) => el.getBoundingClientRect().left > midX) || candidates[0] || null;
}

// アーティファクト（生成済みマインドマップ等）が開いているか。開いているとカード一覧は隠れる。
function isArtifactOpen() {
  const titleEl = document.querySelector("input.artifact-title, .artifact-title, [class*='artifact-title']");
  return Boolean(titleEl && isVisible(titleEl));
}

// マインドマップ等の再生成ボタン（更新/再生成/refresh アイコン）。
function findRegenerateButton() {
  return (
    [...document.querySelectorAll("button, [role='button']")]
      .filter((el) => isVisible(el) && !isDisabled(el))
      .find((el) => {
        const text = normalize(`${el.textContent || ""} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""}`);
        const icon = normalize(el.querySelector("mat-icon, .material-icons")?.textContent);
        return /再生成|再作成|更新|regenerate|recreate|refresh/.test(text) ||
          icon === "refresh" || icon === "autorenew" || icon === "replay" || icon === "sync";
      }) || null
  );
}

// 再生成時に確認ダイアログが出る場合があるので、確定ボタンを押す。
async function confirmRegenerateDialog() {
  const dialog = [...document.querySelectorAll("[role='dialog'], mat-dialog-container, .mat-mdc-dialog-container")]
    .filter((el) => isVisible(el))
    .pop();
  if (!dialog) return;
  const confirm = [...dialog.querySelectorAll("button, [role='button']")]
    .filter((el) => isVisible(el) && !isDisabled(el))
    .find((el) => matchesAny(`${el.textContent || ""} ${el.getAttribute("aria-label") || ""}`, ["再生成", "作成", "続行", "OK", "Regenerate", "Create", "Continue", "Confirm"]));
  if (confirm) {
    await debug("mindmap:regenerate-confirm", summary(confirm));
    await clickElement(confirm);
    await wait(LONG_DELAY);
  }
}

function confirmGenerating(timeout) {
  return waitFor(() => isMindMapGenerating(), timeout, "").then(() => true).catch(() => false);
}

function isMindMapGenerating() {
  const text = normalize(document.body.textContent);
  if (/マインドマップを生成|生成しています|生成中|読み込んでいます|generating mind map|generating|creating mind map/i.test(text)) return true;
  // Studio領域内のプログレス表示
  const progress = [...document.querySelectorAll("mat-progress-bar, mat-progress-spinner, [role='progressbar'], .mat-mdc-progress-spinner")]
    .some((el) => isVisible(el));
  return progress;
}

// マインドマップのキャンバス/描画が表示されているか。
function isMindMapView() {
  return Boolean(document.querySelector("[class*='mind-map'], [class*='mindmap'], .artifact-mindmap, svg .markmap, [class*='markmap']"));
}

function findMindMapControl() {
  // aria-label が「マインドマップ」のカード/ボタン/divを優先（カスタマイズ用ボタンは除外）
  const byAria = [...document.querySelectorAll("[aria-label]")]
    .filter((el) => isVisible(el) && !isDisabled(el))
    .find((el) => matchesAny(el.getAttribute("aria-label"), L.mindMap) && !/カスタマイズ|customize/.test(normalize(el.getAttribute("aria-label"))));
  if (byAria) return clickTargetFor(byAria);

  const byText = findByText(L.mindMap, "button, [role='button'], mat-card, div");
  if (byText) return clickTargetFor(byText);

  return null;
}

function clickTargetFor(el) {
  // div ラッパーの場合は実際に押せる祖先/自身を返す
  return el.closest("button, [role='button'], mat-card, a") || el;
}

// ===========================================================================
//  ノートブック判定・遷移
// ===========================================================================
async function waitForNotebookOpen(beforeUrl, name) {
  try {
    await waitFor(
      () => {
        // 遷移中の /notebook/creating は「開けた」と見なさない。
        if (/\/notebook\/creating/.test(location.pathname)) return false;
        // 実際のノートブックUI（タイトル入力欄 or ソースを追加ボタン）が現れたことを確認する。
        const hasNotebookId = /\/notebook\/[0-9a-f-]{8,}/i.test(location.pathname);
        const ready = Boolean(findTitleInput()) || Boolean(findAddSourceButton()) || Boolean(findSourceDialog());
        return hasNotebookId && ready;
      },
      45000,
      ""
    );
  } catch {
    await snapshot("notebook-open-failed");
    const title = visibleNotebookTitle() || "取得できませんでした";
    throw new Error(`ノートブック「${name}」を開けませんでした。現在URL: ${location.href} / 画面の見出し:「${title}」`);
  }
  await wait(LONG_DELAY);
}

function isNotebookPage() {
  if (/\/notebook\//.test(location.pathname)) return true;
  const text = normalize(document.body.textContent);
  const hasNotebookUi = matchesAny(text, L.addSource) || matchesAny(text, L.mindMap);
  const hasHomeUi = /おすすめのノートブック|最近のノートブック|recent notebooks|featured/i.test(text);
  return hasNotebookUi && !hasHomeUi;
}

function visibleNotebookTitle() {
  const titleInput = findTitleInput();
  if (titleInput) {
    const v = cleanText(titleInput.value || titleInput.textContent || "");
    if (v) return v;
  }
  const heading = [...document.querySelectorAll("h1, [role='heading']")].find((el) => isVisible(el) && cleanText(el.textContent));
  return cleanText(heading?.textContent || "");
}

// ===========================================================================
//  汎用ユーティリティ
// ===========================================================================
function readControlValue(el) {
  if (!el) return "";
  if (el.isContentEditable) return cleanText(el.textContent);
  return el.value ?? "";
}

// MAIN world ヘルパー経由で値を入力する。失敗時は isolated world でフォールバック。
async function fillInput(element, value) {
  await clickElement(element);
  const targetId = `t-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  element.setAttribute("data-yt2nlm-target", targetId);

  const requestId = targetId;
  const result = await new Promise((resolve) => {
    const handler = (event) => {
      if (event.detail?.requestId !== requestId) return;
      window.removeEventListener("__YT2NLM_FILL_DONE__", handler);
      resolve(event.detail);
    };
    window.addEventListener("__YT2NLM_FILL_DONE__", handler);
    window.dispatchEvent(new CustomEvent("__YT2NLM_FILL__", { detail: { targetId, value, requestId } }));
    setTimeout(() => {
      window.removeEventListener("__YT2NLM_FILL_DONE__", handler);
      resolve(null);
    }, 4000);
  });

  element.removeAttribute("data-yt2nlm-target");

  if (result?.ok && readControlValue(element) === value) return true;

  await debug("fill:fallback", { expected: value, actual: readControlValue(element), mainWorld: result });

  // isolated world フォールバック
  element.focus();
  if (typeof element.select === "function") element.select();
  setNativeValue(element, value);
  element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, data: value, inputType: "insertText" }));
  element.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, data: value, inputType: "insertText" }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  await wait(400);

  return readControlValue(element) === value;
}

function setNativeValue(element, value) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  setter ? setter.call(element, value) : (element.value = value);
}

async function clickElement(element) {
  if (!element) throw new Error("クリック対象の要素がありません。");
  await debug("click", summary(element));
  element.scrollIntoView({ block: "center", inline: "center" });
  await wait(DELAY);
  element.focus?.();

  const rect = element.getBoundingClientRect();
  const opts = {
    bubbles: true, cancelable: true, composed: true, view: window,
    pointerId: 1, pointerType: "mouse", isPrimary: true,
    button: 0, buttons: 1, detail: 1,
    clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2
  };
  // ポインタ/マウスの押下〜解放（ホバーやアクティブ状態の処理用）。click は1回だけ行う。
  element.dispatchEvent(new PointerEvent("pointerdown", opts));
  element.dispatchEvent(new MouseEvent("mousedown", opts));
  element.dispatchEvent(new PointerEvent("pointerup", opts));
  element.dispatchEvent(new MouseEvent("mouseup", opts));

  // クリックの本処理は1回のみ。合成 click と element.click() を両方行うと
  // 「新規作成」のような1回でノートブックを作るボタンが二重に発火してしまう。
  if (typeof element.click === "function") {
    element.click();
  } else {
    element.dispatchEvent(new MouseEvent("click", opts));
  }
  await wait(DELAY);
}

function pressEnter(element) {
  const opts = { bubbles: true, cancelable: true, key: "Enter", code: "Enter", keyCode: 13, which: 13 };
  element.dispatchEvent(new KeyboardEvent("keydown", opts));
  element.dispatchEvent(new KeyboardEvent("keypress", opts));
  element.dispatchEvent(new KeyboardEvent("keyup", opts));
}

function findFirst(selectors) {
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el && isVisible(el) && !isDisabled(el)) return el;
  }
  return null;
}

function findByText(labels, selector) {
  const els = [...document.querySelectorAll(selector)];
  return (
    els.find((el) => {
      if (!isVisible(el) || isDisabled(el)) return false;
      const text = `${el.textContent || ""} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""}`;
      return matchesAny(text, labels);
    }) || null
  );
}

function matchesAny(text, labels) {
  const t = normalize(text);
  if (!t) return false;
  return labels.some((label) => t.includes(normalize(label)));
}

function isVisible(element) {
  if (!element) return false;
  // スクリーンリーダー専用の隠し要素（cdk-visually-hidden / aria-live アナウンサ）はクリック対象にしない。
  const cls = String(element.className || "");
  if (/cdk-visually-hidden|cdk-live-announcer/.test(cls)) return false;
  if (element.getAttribute?.("aria-live")) return false;

  const style = getComputedStyle(element);
  if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return false;

  const rect = element.getBoundingClientRect();
  // 1px 程度の不可視要素や画面外（左/上に完全にはみ出し）を除外する。
  if (rect.width <= 2 || rect.height <= 2) return false;
  if (rect.right <= 0 || rect.bottom <= 0) return false;
  return true;
}

function isDisabled(element) {
  return Boolean(
    element.disabled ||
      element.getAttribute("aria-disabled") === "true" ||
      element.closest("[disabled], [aria-disabled='true']")
  );
}

function isSameName(a, b) {
  return normalize(a) === normalize(b) && normalize(a).length > 0;
}

function safeVideoId(url) {
  try {
    return new URL(url).searchParams.get("v") || "";
  } catch {
    return "";
  }
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalize(value) {
  return cleanText(value).toLowerCase();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForDocumentReady() {
  if (document.readyState === "complete" || document.readyState === "interactive") return Promise.resolve();
  return new Promise((resolve) => document.addEventListener("DOMContentLoaded", resolve, { once: true }));
}

// predicate が throw した場合は即座に reject（エラートースト検出等に使用）。
function waitFor(predicate, timeout = 30000, timeoutMessage = "タイムアウトしました。") {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let value;
      try {
        value = predicate();
      } catch (error) {
        reject(error);
        return;
      }
      if (value) {
        resolve(value);
        return;
      }
      if (Date.now() - start > timeout) {
        reject(new Error(timeoutMessage || "タイムアウトしました。"));
        return;
      }
      setTimeout(tick, 300);
    };
    tick();
  });
}

// ===========================================================================
//  ステータス・デバッグログ（chrome.storage.local 経由でDevToolsに依存しない）
// ===========================================================================
function status(text, kind = "info") {
  const entry = { kind, text, at: Date.now() };
  debug(`status:${kind}`, text);
  appendStorage("flowStatus", entry, 60);
  chrome.runtime.sendMessage({ type: "FLOW_STATUS", ...entry }).catch(() => {});
}

async function debug(label, data) {
  try {
    const entry = { timestamp: new Date().toISOString(), label, data: cloneForLog(data) };
    await appendStorage("debugLog", entry, 400);
  } catch {
    // ログ記録の失敗で本処理を止めない
  }
}

function appendStorage(key, entry, max) {
  return chrome.storage.local
    .get({ [key]: [] })
    .then((store) => chrome.storage.local.set({ [key]: [...store[key], entry].slice(-max) }))
    .catch(() => {});
}

function cloneForLog(data) {
  if (data === undefined || data === null) return data;
  try {
    return JSON.parse(JSON.stringify(data));
  } catch {
    return String(data);
  }
}

async function snapshot(label, extra = {}) {
  await debug(`snapshot:${label}`, {
    url: location.href,
    title: document.title,
    isNotebookPage: isNotebookPage(),
    notebookTitle: visibleNotebookTitle(),
    dialogOpen: Boolean(findSourceDialog()),
    sourceState: sourceListState(),
    headings: collect("h1, h2, h3, [role='heading']", 15),
    buttons: collect("button, a[aria-label], [role='button'], div[aria-label]", 60),
    inputs: collect("input, textarea", 15),
    errorToast: findErrorToast(),
    bodyTextSample: cleanText(document.body?.textContent || "").slice(0, 1200),
    ...extra
  });
}

function collect(selector, limit) {
  return [...document.querySelectorAll(selector)]
    .filter((el) => isVisible(el))
    .slice(0, limit)
    .map(summary);
}

function summary(element) {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return {
    tag: element.tagName?.toLowerCase(),
    id: element.id || "",
    classes: String(element.className || "").slice(0, 160),
    role: element.getAttribute?.("role") || "",
    ariaLabel: element.getAttribute?.("aria-label") || "",
    title: element.getAttribute?.("title") || "",
    type: element.getAttribute?.("type") || "",
    value: "value" in element ? String(element.value || "").slice(0, 200) : "",
    text: cleanText(element.textContent || "").slice(0, 200),
    disabled: isDisabled(element),
    rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) }
  };
}

function decorateError(message) {
  const parts = [message];
  if (currentContext.openedNotebook) parts.push(`操作対象ノートブック:「${currentContext.openedNotebook}」`);
  else if (currentContext.channelName) parts.push(`対象チャンネル:「${currentContext.channelName}」`);
  if (currentContext.videoUrl) parts.push(`追加対象URL: ${currentContext.videoUrl}`);
  parts.push(`現在URL: ${location.href}`);
  const heading = visibleNotebookTitle();
  if (heading) parts.push(`画面の見出し:「${heading}」`);
  const toast = findErrorToast();
  if (toast) parts.push(`画面のエラー表示:「${toast}」`);
  return parts.join(" / ");
}
