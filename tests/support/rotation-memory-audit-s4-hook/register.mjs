// D 監査（AquaGauss）: 子プロセスで runtime の1か所の文面だけを、読み込みの時に1字変える loader を登録する（loader.mjs）。
// 使い方: node --import <この file> <script>（変える場所は環境変数 MUTATE_SUFFIX・MUTATE_FROM・MUTATE_TO で渡す）。ディスク上の file は変えない。
import { register } from 'node:module';
register('./loader.mjs', import.meta.url);
