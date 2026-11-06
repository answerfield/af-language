# af-language

answerfield ist eine typisierte, deklarativ-reaktive Sprache für digitale Assessments. Dieses Repository enthält die Sprache: Grammatik, Language Server, Compiler und Standardbibliothek.

## Pakete

| Paket | Inhalt |
|---|---|
| `@answerfield/language` | Grammatik, generierter Parser, Validierung, Language Server und Syntaxfarben |
| `@answerfield/compiler` | Übersetzt answerfield-Quelltext (`.af`) in ein Bundle |
| `@answerfield/editing` | Typen zwischen Sprachserver und Editor |
| `@answerfield/stdlib` | Standardbibliothek (`std.af`) |

Die Pakete liegen als Dateien an den [Releases](https://github.com/answerfield/af-language/releases).

## Bauen und testen

Voraussetzung ist Node.js 22.12 oder neuer.

```sh
npm ci && npm run build && npm test
```

## Lizenzen

| Pfad | Lizenz |
|---|---|
| `packages/stdlib` | 0BSD |
| `packages/language/src/builtin/prelude.af` | 0BSD |
| alles andere (Code) | Apache-2.0 |

Die Lizenz jeder Datei steht in `REUSE.toml`, die Lizenztexte liegen in `LICENSES/`.

## Mitwirken

Issues und Pull Requests sind willkommen, siehe [CONTRIBUTING.md](CONTRIBUTING.md).
