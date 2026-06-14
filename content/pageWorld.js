// MAIN world（ページ本体のJSコンテキスト）で動作するヘルパー。
// NotebookLMはAngular（zone.js）を使うため、isolated worldから値を入れても
// フォーム状態が更新されないことがある。MAIN world側で execCommand('insertText')
// などのネイティブ入力を発火することで、Angularのリアクティブフォームを確実に更新する。
//
// content/notebooklm.js（isolated world）とは CustomEvent でやり取りする。

(() => {
  const VERSION = "1.0.0-pageworld";
  if (window.__YT2NLM_PAGE_WORLD__ === VERSION) return;
  window.__YT2NLM_PAGE_WORLD__ = VERSION;

  // isolated world からの「この要素に値を入れて」という依頼を受ける。
  window.addEventListener("__YT2NLM_FILL__", (event) => {
    const detail = event.detail || {};
    const targetId = detail.targetId;
    const value = String(detail.value ?? "");
    const requestId = detail.requestId;
    const element = targetId
      ? document.querySelector(`[data-yt2nlm-target="${cssEscape(targetId)}"]`)
      : null;

    let ok = false;
    let finalValue = "";
    if (element) {
      try {
        fillControl(element, value);
        finalValue = readValue(element);
        ok = finalValue === value;
      } catch (error) {
        finalValue = `ERROR: ${error?.message || error}`;
      }
    }

    window.dispatchEvent(
      new CustomEvent("__YT2NLM_FILL_DONE__", {
        detail: { requestId, ok, value: finalValue }
      })
    );
  });

  function readValue(element) {
    if (element.isContentEditable) return element.textContent || "";
    return element.value ?? "";
  }

  // 各種イベントを段階的に発火して値を確実に反映する。
  function fillControl(element, value) {
    element.scrollIntoView?.({ block: "center", inline: "center" });
    element.focus();
    element.click?.();

    if (element.isContentEditable) {
      fillContentEditable(element, value);
      return;
    }

    // 1. 既存値を全選択して削除（ネイティブ操作）
    selectAll(element);
    document.execCommand("delete", false);

    // 2. ネイティブ insertText を試す（Angularが拾う beforeinput/input が発火する）
    let inserted = false;
    try {
      inserted = document.execCommand("insertText", false, value);
    } catch {
      inserted = false;
    }

    // 3. 反映されていなければ、ネイティブsetter + 各種イベントでフォールバック
    if (readValue(element) !== value) {
      nativeSetValue(element, value);
      dispatchInputEvents(element, value);
    } else if (!inserted) {
      dispatchInputEvents(element, value);
    }

    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function fillContentEditable(element, value) {
    selectAll(element);
    document.execCommand("delete", false);
    if (!document.execCommand("insertText", false, value)) {
      element.textContent = value;
    }
    element.dispatchEvent(
      new InputEvent("input", { bubbles: true, cancelable: true, data: value, inputType: "insertText" })
    );
  }

  function selectAll(element) {
    if (typeof element.select === "function") {
      element.select();
      return;
    }
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function nativeSetValue(element, value) {
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
    setter ? setter.call(element, value) : (element.value = value);
  }

  function dispatchInputEvents(element, value) {
    element.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        data: value,
        inputType: "insertText"
      })
    );
    element.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        cancelable: true,
        data: value,
        inputType: "insertText"
      })
    );
  }

  function cssEscape(value) {
    if (window.CSS && CSS.escape) return CSS.escape(value);
    return String(value).replace(/["\\]/g, "\\$&");
  }
})();
