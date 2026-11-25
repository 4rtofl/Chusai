# Chusai

PR のブランチに main を取り込み、壊れるところを Claude Code に直させて push する GitHub Actions です。4rtofl の Gasho と GashoPlugins で使います。

PR を並べて出すと、先に main に入った PR と衝突したり、衝突しないのに main と合わせると型チェックが落ちたりします。Chusai は、人が手を付ける前にそれを直しておきます。

## 動き

| きっかけ | 調べる PR | 直すもの |
|---|---|---|
| main への push（PR のマージ） | 開いている PR すべて（main を取り込み済みのものを除く） | 衝突と、main と合わせると検証が落ちる食い違い |
| PR を開いた・push した・Draft を外した | その PR だけ | 衝突だけ（食い違いは、その PR の CI が main と合わせた結果で見つける） |

Draft の PR も調べます。次の PR は調べません。

- ラベル `chusai:skip` が付いている（ラベルの名前は設定で変えられる）
- fork からの PR（App のトークンで push できず、シークレットも渡らない）
- base が main（既定のブランチ）ではない

PR ごとに、次の順で進みます。

1. PR のブランチに main を `git merge --no-commit` する。
2. 衝突したら、Claude Code に解消させる。衝突しなかったら、main への push のときだけ、入れるコマンドと検証のコマンドを流す。落ちて、かつ PR のブランチだけの CI（Check Run）がすべて通っているときだけ、Claude Code に直させる。PR のブランチだけでも落ちているなら、PR 自身の問題なので触りません。
3. Claude Code は、ファイルの編集・`git add`・読むだけの git コマンド・導入先の入れるコマンドと検証のコマンドだけを使えます。commit・push・ネットワークへの接続はできません。最後に「解消した」か「人の判断が要る」を返します。
4. Chusai が、衝突の印が残っていないかを見てマージコミットを作り、入れるコマンドと検証のコマンドを流し直します。
5. すべて通ったら、App の名前（`chusai[bot]`）で PR のブランチへ push し、何をしたかを PR にコメントします。force push はしません。その間に人が push していたら、push は拒否されて何もせずに終わります（人の push で Chusai がもう一度動きます）。
6. Claude Code が決められなかったとき・費用や時間の上限まで解消し終わらなかったとき・検証が通らなかったときは push せず、衝突したファイルと判断してほしい点を PR にコメントします。
7. Claude Code が API のエラーなどで途中で失敗したとき、push が権限などで拒否されたときは、PR に何も書かずにジョブを失敗にします。次の実行でやり直します。

PR へのコメントは 1 件だけで、次の実行で書き換えます。人の判断を求めたあと、PR のブランチが変わるまでは Claude Code を呼びません（main への push のたびに同じ衝突で費用がかからないように）。人が解消して push すると、コメントは「取り込みは済んでいます」に変わります。

Claude Code に渡す解き方は [prompts/resolve.md](prompts/resolve.md) です。同じ仕事の旧版と新版がぶつかっていないかを先に見極め、base・PR・main の 3 点を読んで決め、両側が足した行が残っているかを機械で照合します。

## 導入

### 1. GitHub App を作る（Org で 1 回）

Org の Settings → Developer settings → GitHub Apps → New GitHub App で作ります。

- Webhook：Active のチェックを外す
- Repository permissions：

  | 権限 | 理由 |
  |---|---|
  | Contents: Read and write | PR のブランチへ push する |
  | Pull requests: Read and write | PR の一覧を読み、コメントを書く |
  | Checks: Read-only | PR のブランチの CI が通っているかを読む |
  | Workflows: Read and write | main が `.github/workflows/` を変えたあとの取り込みは、その変更を含む push になる。この権限が無いと拒否される |

- 作ったあと、秘密鍵（private key）を生成して、導入するリポジトリにインストールする

`GITHUB_TOKEN` で push すると、その push で始まる PR のワークフローが走りません。App のトークンで push するので、Chusai の push のあとも導入先の CI が普段どおり走ります。

### 2. App のシークレットを登録する（Org で 1 回）

Org の Settings → Secrets and variables → Actions → Secrets で登録し、Repository access を導入するリポジトリに絞ります。

| 名前 | 中身 |
|---|---|
| `CHUSAI_APP_ID` | App の ID |
| `CHUSAI_APP_PRIVATE_KEY` | App の秘密鍵（.pem の中身） |

### 3. Claude の認証を用意する

Workload Identity Federation（WIF）を使います。GitHub Actions が発行する OIDC トークンを、Claude API の短い期限のトークンに交換するので、API キーをシークレットに置かずに済みます。GitHub の OIDC トークンは約 5 分で切れるので、Chusai は Claude Code が動いている間、4 分ごとにトークンのファイルを書き直します。

**Claude Console で（組織の admin が 1 回）**

1. Settings → Workload identity → **Connect workload** → **GitHub Actions** を選ぶ（uiux-auto-reviewer の発行元とサービスアカウントがあれば、それを使える）。
2. Chusai 用のルールを作る。uiux-auto-reviewer のルールは `event_name: pull_request` に絞ってあり、main への push で動く Chusai には使えません。

   | 項目 | 値 |
   |---|---|
   | `subject_prefix` | `repo:4rtofl@338377614/*`（4rtofl の数値 ID。`gh api orgs/4rtofl -q .id` で調べる） |
   | `audience` | `https://api.anthropic.com` |
   | `claims` | `job_workflow_ref`: `4rtofl/Chusai/.github/workflows/resolve.yml@refs/heads/main` |
   | `oauth_scope` | `workspace:developer` |
   | `token_lifetime_seconds` | `600` |

   `job_workflow_ref` で、このリポジトリの再利用ワークフローから動くジョブだけに絞ります。`event_name` は push と pull_request の両方なので指定しません。
3. ワークスペースに月の利用上限を設定する（下の「費用」）。
4. ルール ID（`fdrl_...`）を控える。組織 ID・サービスアカウント ID・ワークスペース ID は uiux-auto-reviewer と同じ値を使えます。

**GitHub で**

導入するリポジトリの Settings → Secrets and variables → Actions → **Variables** に登録します。どれも秘密ではありません。

| 名前 | 中身 |
|---|---|
| `CHUSAI_ANTHROPIC_FEDERATION_RULE_ID` | Chusai 用のルール ID（`fdrl_...`）。`ANTHROPIC_FEDERATION_RULE_ID` は uiux-auto-reviewer が使っているので別の名前にする |
| `ANTHROPIC_ORGANIZATION_ID` | 組織 ID |
| `ANTHROPIC_SERVICE_ACCOUNT_ID` | サービスアカウント ID（`svac_...`、省略可） |
| `ANTHROPIC_WORKSPACE_ID` | ワークスペース ID（`wrkspc_...`、ルールが複数のワークスペースにまたがるときは必須） |

**API キーで動かす場合**

WIF を使わないなら、`CHUSAI_ANTHROPIC_FEDERATION_RULE_ID` を登録せず、シークレット `CHUSAI_ANTHROPIC_API_KEY` に API キーを入れます。両方あるときは WIF を使います。

### 4. 導入するリポジトリに置くもの

- `.github/workflows/chusai.yml`：[examples/chusai.yml](examples/chusai.yml) をコピーします。最初は `dry-run: true` のままにし、job summary で何をするはずだったかを読んでから外します。
- `.github/chusai.json`（任意）：入れるコマンドと検証のコマンドです（下記）。無ければ既定値を使います。

`npm ci` に GitHub Packages が要るリポジトリ（GashoPlugins）は、`permissions` に `packages: read` を足し、`registry-url: https://npm.pkg.github.com` と `registry-scope: "@4rtoflow"` を渡します。

設定ファイルは、PR のブランチではなく main の最新から読みます。PR の中で、自分のマージを push させるかどうかを決めるコマンドを書き換えられないようにするためです。

### 設定（`.github/chusai.json`）

```json
{
  "install": ["npm ci"],
  "verify": ["npm run typecheck", "npm test", "npm run web:build"]
}
```

| キー | 意味 | 既定値 |
|---|---|---|
| `install` | 検証の前に流すコマンド | `["npm ci"]` |
| `verify` | push の前にすべて通す必要があるコマンド（1 つ以上） | `["npm run typecheck", "npm test"]` |
| `lockfile` | lockfile を作り直すコマンド。lockfile が衝突したとき、Claude Code は手で直さずにこれを流す。無いなら `null` | `npm install --package-lock-only --ignore-scripts --no-audit --no-fund` |
| `skipLabel` | このラベルが付いた PR は調べない | `chusai:skip` |
| `maxBudgetUsd` | 1 回の解消で Claude Code が使ってよい費用の上限（ドル） | `5` |
| `claudeTimeoutMinutes` | Claude Code を止めるまでの時間（分） | `30` |
| `commandTimeoutMinutes` | 入れるコマンドと検証のコマンドを 1 つずつ止めるまでの時間（分） | `20` |

## 動かしたあとに起きること

- **承認が外れる。** main のルールセットで `dismiss_stale_reviews_on_push` が有効なら、Chusai の push で承認が外れ、もう一度承認が要ります。
- **手元のブランチの push が拒否される。** Chusai が push したあと、手元で取り込まずに push すると拒否されます。`git pull` で取り込んでから push してください。force push で Chusai の commit を消さないでください。
- **PR のワークフローが走り直す。** Chusai の push で、CI や uiux-auto-reviewer が走ります。Chusai 自身ももう一度動きますが、main を取り込み済みなので何もせずに終わります。
- **main への push のたびに、開いている PR の数だけジョブが走る。** 各ジョブで `npm ci` と検証が走ります（同時に 4 本まで。`max-parallel` で変えられる）。Claude Code を呼ぶのは、衝突したときと検証が落ちたときだけです。

## 費用

モデルは `claude-opus-5-5` です（入力 $4、出力 $20、キャッシュの読み込み $0.20／100 万トークン）。1 回の解消で $1〜2 ほどの見込みで、実際の値はコメントと job summary の末尾に出ます。設定の `maxBudgetUsd` を超えると Claude Code は止まり、Chusai は push せずにコメントで知らせます。

## 手元で試す

PR に書き込まずに、解消して検証するところまでを手元で流せます。**Chusai はワークスペースで checkout とマージをするので、専用の clone を使ってください。** Claude Code は PATH にある `claude` を、そのログインのまま使います（手元の設定とフックは読みません）。PATH の `claude` が古いときは、`--claude ~/.local/bin/claude` のように指定します。

```sh
git clone https://github.com/4rtofl/Gasho.git /tmp/chusai-gasho
CHUSAI_GITHUB_TOKEN=$(gh auth token) node src/main.ts resolve --repo 4rtofl/Gasho --pr 261 --workspace /tmp/chusai-gasho --dry-run
# main への push のときの動き（衝突しない食い違いも見る）
CHUSAI_GITHUB_TOKEN=$(gh auth token) node src/main.ts resolve --repo 4rtofl/Gasho --pr 261 --workspace /tmp/chusai-gasho --event push --dry-run
# 調べる PR の一覧
CHUSAI_GITHUB_TOKEN=$(gh auth token) node src/main.ts select --repo 4rtofl/Gasho --event push
```

結果（解消の差分、書くはずだったコメント）は標準出力に出ます。

## 開発

```sh
npm ci
npm run typecheck
npm test
```

Node.js 24 で、TypeScript をビルドせずにそのまま実行します。実行時の依存はありません。テストは、手元に作った git のリポジトリで、偽の Claude Code と偽の GitHub を使って、取り込みから push までを流します。
