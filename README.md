Claude Code Opus4.8 generated codes



# YouTube to NotebookLM Mind Map

YouTube の動画ページからワンクリックで Google NotebookLM に動画 URL をソースとして追加し、
NotebookLM Studio のビジュアルな「マインドマップ」を自動生成する Chrome / Edge 拡張機能（Manifest V3）。

NotebookLM の API・Enterprise API・非公開 API は一切使用せず、NotebookLM の Web 画面を
コンテンツスクリプトから操作して実現します。

## 動作の流れ

1. YouTube 動画ページで拡張機能アイコンをクリックすると、ポップアップに動画情報（サムネイル・
タイトル・チャンネル名）と「NotebookLMに追加」ボタンが表示されます。
2. **字幕がない動画**では「字幕がないため追加できません」と表示し、NotebookLM 操作は一切開始しません。
3. ボタンを押すと NotebookLM タブを前面に表示し、以下を自動実行します。

   * YouTube チャンネル名に対応するノートブックを検索（無ければ新規作成し、名前をチャンネル名に設定）
   * YouTube 動画 URL をソースとして追加
   * **ソース一覧に実際に追加されたことを確認**してから
   * Studio パネルの「マインドマップ」を起動
4. 進捗はポップアップにリアルタイム表示されます。失敗時は段階が分かるエラーを表示します。

## インストール（開発者モード）

1. Chrome / Edge で `chrome://extensions`（Edge は `edge://extensions`）を開く
2. 「デベロッパー モード」を有効化
3. 「パッケージ化されていない拡張機能を読み込む」でこのフォルダを選択

## ファイル構成

|ファイル|役割|
|-|-|
|`manifest.json`|Manifest V3 定義（権限・コンテンツスクリプト）|
|`background.js`|タブ制御・スクリプト注入・フロー起動・デバッグJSON保存|
|`content/youtube.js`|YouTube 動画ページから情報抽出（字幕有無判定を含む）|
|`content/notebooklm.js`|NotebookLM の UI 自動操作本体（注入される）|
|`content/pageWorld.js`|MAIN world でのフォーム入力ヘルパー（Angular 対応）|
|`popup/`|ポップアップ UI（動画情報・進捗・デバッグ操作）|

## 設計上のポイント

* **Angular フォーム対応**: URL 入力は MAIN world で `execCommand('insertText')` などのネイティブ
入力イベントを発火し、Angular のリアクティブフォームが確実に更新されるようにしています
（単なる `element.value = url` では不十分なため）。
* **ソース追加の完了判定**: 「挿入」ボタンを押しただけでは成功とせず、ソース一覧に対象動画が
現れたこと（件数増加・動画ID・タイトル・YouTube 種別表示）を確認します。空のプレースホルダ
説明文を追加済みと誤判定しません。
* **多言語対応**: 日本語 UI / 英語 UI の両方のラベルを考慮し、aria-label・テキスト・クラスを
併用して DOM 選択を堅牢化しています。
* **デバッグ情報**: DevTools に依存せず、`chrome.storage.local` に進捗ログ・詳細ログ・各段階の
画面スナップショット（ボタン/入力欄/見出し一覧、ダイアログ情報、クリック・入力対象要素、
エラー時の画面状態）を記録し、JSON ファイルとして任意の保存先に書き出せます。
* **ログの初期化**: 拡張機能のリロード時、および新しい実行の開始時に古いログを破棄します。

## 権限

`activeTab`, `scripting`, `tabs`, `windows`, `storage`, `downloads` と、
`youtube.com` / `notebooklm.google.com` への host permissions のみを使用します。

## 注意

NotebookLM の UI は予告なく変更される可能性があります。動作しなくなった場合は、ポップアップの
「保存先を選んでデバッグ情報を保存」でデバッグ JSON を保存すると、どの段階で・どの画面要素で
失敗したかを確認できます。

