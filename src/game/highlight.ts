// Evidenziazione della sintassi riga per riga, senza librerie. Restituisce HTML già escapato.
// Un tokenizzatore generico configurato per linguaggio (parole chiave, tipi, commenti, stringhe) e
// lexer dedicati dove la forma è diversa: assembly, HTML/XML (con <script> e <style> dentro), CSS, Markdown.
// Lo stato passa da una riga all'altra: commenti a blocchi, stringhe su più righe, tag aperti, blocchi annidati.
// Classi dei colori: tk-kw, tk-type, tk-str, tk-num, tk-com, tk-def, tk-call, tk-const, tk-builtin, tk-dec,
// tk-pre, tk-tag, tk-attr, tk-prop, tk-var (token in styles.css).

import { t } from "./i18n";

const words = (s: string) => new Set(s.split(/\s+/).filter(Boolean));

// ---------- Linguaggi ----------

interface Multi {
  /** Apertura, ancorata all'inizio del resto della riga. */
  open: RegExp;
  /** Chiusura; se manca è il gruppo 1 dell'apertura (""" o '''), oppure una funzione dell'apertura. */
  close?: string | ((m: RegExpMatchArray) => string);
  /** La barra rovescia salta il carattere dopo. */
  esc?: boolean;
  cls?: "str" | "com";
}

interface Spec {
  label: string;
  line?: string[];
  block?: [string, string][];
  /** Virgolette delle stringhe su una riga. */
  quotes?: string;
  /** Apice singolo solo come carattere ('a', '\n'): altrimenti è altro (lifetime di Rust, apostrofi). */
  charLit?: boolean;
  multi?: Multi[];
  kw?: Set<string>;
  types?: Set<string>;
  consts?: Set<string>;
  builtins?: Set<string>;
  /** Parole dopo cui il nome è una definizione (def, fn, class...). */
  defAfter?: Set<string>;
  /** Le parole con l'iniziale maiuscola sono tipi (Java, Rust, Haskell...). */
  capsType?: boolean;
  /** Parole chiave senza maiuscole e minuscole (SQL). */
  nocase?: boolean;
  /** Direttive del preprocessore all'inizio della riga (#include, #define). */
  preproc?: boolean;
  /** Decoratori, annotazioni, attributi. */
  dec?: RegExp;
  /** Variabili con il loro segno ($x, @x). */
  vars?: RegExp;
  ident?: RegExp;
  /** Stringa seguita da due punti: è una chiave (JSON). */
  keyStrings?: boolean;
  /** Inizio della riga con una forma propria (chiavi di YAML e TOML, regole di Makefile). */
  head?: (line: string) => [string, number] | undefined;
  /** Nome seguito da ! è una macro (Rust). */
  macros?: boolean;
}

const C_KW = "auto break case const continue default do else enum extern for goto if inline register restrict return sizeof static struct switch typedef union volatile while _Alignas _Alignof _Atomic _Generic _Noreturn _Static_assert _Thread_local alignas alignof static_assert thread_local typeof";
const C_TYPES = "void char short int long float double signed unsigned bool _Bool size_t ssize_t ptrdiff_t intptr_t uintptr_t int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t FILE va_list off_t pid_t time_t wchar_t socklen_t";
const C_BUILTINS = "printf fprintf sprintf snprintf scanf sscanf fscanf puts fputs gets fgets putchar getchar fopen fclose fread fwrite fflush fseek ftell malloc calloc realloc free memcpy memmove memset memcmp strlen strcpy strncpy strcat strncat strcmp strncmp strchr strrchr strstr strdup atoi atol strtol strtoul exit abort system read write open close setvbuf perror assert qsort bsearch rand srand abs";

const JS_KW = "break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new return super switch throw try typeof var void while with yield async await of from as get set static";
const TS_KW = `${JS_KW} interface type implements enum readonly private public protected abstract declare namespace module keyof infer is satisfies override`;
const JS_CONSTS = "true false null undefined this NaN Infinity";
const JS_BUILTINS = "console Math JSON Object Array String Number Boolean Promise Map Set WeakMap Symbol Date RegExp Error parseInt parseFloat setTimeout clearTimeout setInterval fetch require document window globalThis process";

const SH_KW = "if then else elif fi for while until do done case esac in function select time return break continue local export readonly declare";
const SH_BUILTINS = "echo printf cd pwd ls cat grep sed awk find xargs test read source alias unset shift exit exec eval set trap kill sleep mkdir rm cp mv chmod chown touch head tail sort uniq wc tr cut curl wget git make sudo";
const SH_VARS = /^\$(\{[^}]*\}|\(\(?|[A-Za-z_]\w*|[@#?$!*0-9-])/;

const SQL_KW = "select from where and or not insert into values update set delete create table drop alter add column index view primary key foreign references join inner left right full outer cross on as group by order having limit offset union all distinct case when then else end in is null like between exists begin commit rollback transaction default unique check constraint if returning with recursive asc desc grant revoke";

const SPECS = {
  python: {
    label: "Python",
    line: ["#"],
    quotes: `"'`,
    multi: [{ open: /^[rbfuRBFU]{0,2}("""|''')/, esc: true }],
    kw: words("and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case type"),
    consts: words("True False None self cls"),
    builtins: words("print len range dict list set tuple str int float bool bytes bytearray isinstance issubclass super open enumerate zip map filter sorted reversed min max sum any all abs round getattr setattr hasattr type object input iter next id hash repr format vars dir Exception ValueError TypeError KeyError IndexError AttributeError RuntimeError StopIteration ConnectionError OSError"),
    defAfter: words("def class"),
    dec: /^@[\w.]+/,
  },
  c: {
    label: "C",
    line: ["//"],
    block: [["/*", "*/"]],
    quotes: `"'`,
    charLit: true,
    kw: words(C_KW),
    types: words(C_TYPES),
    consts: words("NULL true false EOF stdin stdout stderr"),
    builtins: words(C_BUILTINS),
    defAfter: words("struct union enum"),
    preproc: true,
  },
  cpp: {
    label: "C++",
    line: ["//"],
    block: [["/*", "*/"]],
    quotes: `"'`,
    charLit: true,
    multi: [{ open: /^R"([^(\s]*)\(/, close: (m) => `)${m[1]}"` }],
    kw: words(`${C_KW} class namespace template typename public private protected virtual override final friend operator new delete this using try catch throw noexcept constexpr consteval constinit decltype explicit mutable static_cast dynamic_cast reinterpret_cast const_cast co_await co_return co_yield concept requires export import module`),
    types: words(`${C_TYPES} string vector map unordered_map set unordered_set array pair tuple unique_ptr shared_ptr weak_ptr optional variant string_view auto`),
    consts: words("nullptr NULL true false this"),
    builtins: words(`${C_BUILTINS} std cout cin cerr endl make_unique make_shared move forward swap sort find begin end size push_back emplace_back`),
    defAfter: words("class struct union enum namespace"),
    capsType: true,
    preproc: true,
  },
  csharp: {
    label: "C#",
    line: ["//"],
    block: [["/*", "*/"]],
    quotes: `"'`,
    charLit: true,
    multi: [
      { open: /^\$*"""/, close: '"""' },
      { open: /^(\$@|@\$|@)"/, close: '"' },
    ],
    kw: words("abstract as base break case catch checked class const continue default delegate do else enum event explicit extern finally fixed for foreach goto if implicit in interface internal is lock namespace new operator out override params private protected public readonly record ref return sealed sizeof stackalloc static struct switch throw try typeof unchecked unsafe using virtual volatile while async await var get set init value yield where when and or not with required file partial global"),
    types: words("bool byte sbyte char decimal double float int uint long ulong short ushort object string void dynamic nint nuint"),
    consts: words("true false null this"),
    builtins: words("Console Math String List Dictionary Task Exception Array Enumerable Linq nameof"),
    defAfter: words("class struct interface enum record namespace"),
    capsType: true,
    preproc: true,
    dec: /^\[[A-Z][\w.]*(?=[\](])/,
  },
  java: {
    label: "Java",
    line: ["//"],
    block: [["/*", "*/"]],
    quotes: `"'`,
    charLit: true,
    multi: [{ open: /^"""/, close: '"""' }],
    kw: words("abstract assert break case catch class continue default do else enum extends final finally for goto if implements import instanceof interface native new package private protected public return static strictfp super switch synchronized this throw throws transient try volatile while var record sealed permits yield non-sealed"),
    types: words("boolean byte char short int long float double void"),
    consts: words("true false null this"),
    builtins: words("System String Math Integer Long Double Boolean Object List ArrayList Map HashMap Set HashSet Arrays Collections Optional Exception RuntimeException Thread"),
    defAfter: words("class interface enum record"),
    capsType: true,
    dec: /^@[\w.]+/,
  },
  kotlin: {
    label: "Kotlin",
    line: ["//"],
    block: [["/*", "*/"]],
    quotes: `"'`,
    charLit: true,
    multi: [{ open: /^"""/, close: '"""' }],
    kw: words("as break class continue do else for fun if in interface is object package return super throw try typealias typeof val var when while by catch constructor init finally get set import where data sealed enum open override private protected public internal abstract final inner lateinit companion suspend inline reified operator infix tailrec vararg const"),
    types: words("Int Long Short Byte Double Float Boolean Char String Unit Any Nothing Array List MutableList Map Set"),
    consts: words("true false null this it"),
    builtins: words("println print listOf mutableListOf mapOf setOf arrayOf require check error lazy let apply also run with repeat"),
    defAfter: words("fun class interface object"),
    capsType: true,
    dec: /^@[\w.:]+/,
  },
  go: {
    label: "Go",
    line: ["//"],
    block: [["/*", "*/"]],
    quotes: `"'`,
    charLit: true,
    multi: [{ open: /^`/, close: "`" }],
    kw: words("break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var"),
    types: words("bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr any comparable"),
    consts: words("true false nil iota"),
    builtins: words("append cap close complex copy delete imag len make new panic print println real recover min max clear fmt"),
    defAfter: words("func type"),
  },
  rust: {
    label: "Rust",
    line: ["//"],
    block: [["/*", "*/"]],
    quotes: `'`,
    charLit: true,
    multi: [
      { open: /^r(#*)"/, close: (m) => `"${m[1]}` },
      { open: /^b?"/, close: '"', esc: true },
    ],
    kw: words("as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return static struct super trait type unsafe use where while yield"),
    types: words("i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str String Vec Option Result Box Rc Arc RefCell Cell HashMap HashSet BTreeMap Self"),
    consts: words("true false self None Some Ok Err"),
    builtins: words("drop clone unwrap expect iter into"),
    defAfter: words("fn struct enum trait type mod union"),
    capsType: true,
    dec: /^#!?\[[^\]]*\]?/,
    macros: true,
  },
  swift: {
    label: "Swift",
    line: ["//"],
    block: [["/*", "*/"]],
    quotes: `"`,
    multi: [{ open: /^#*"""/, close: '"""' }],
    kw: words("associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private protocol public rethrows static struct subscript typealias var break case continue default defer do else fallthrough for guard if in repeat return switch where while as catch is throw throws try async await some any mutating override final lazy weak"),
    types: words("Int Double Float Bool String Character Array Dictionary Set Optional Void Any"),
    consts: words("true false nil self Self super"),
    builtins: words("print debugPrint min max abs zip stride fatalError"),
    defAfter: words("func class struct enum protocol extension"),
    capsType: true,
    dec: /^@\w+/,
  },
  js: {
    label: "JavaScript",
    line: ["//"],
    block: [["/*", "*/"]],
    quotes: `"'`,
    multi: [{ open: /^`/, close: "`", esc: true }],
    kw: words(JS_KW),
    consts: words(JS_CONSTS),
    builtins: words(JS_BUILTINS),
    defAfter: words("function class"),
    ident: /^[A-Za-z_$][\w$]*/,
    dec: /^@[\w.]+/,
  },
  ts: {
    label: "TypeScript",
    line: ["//"],
    block: [["/*", "*/"]],
    quotes: `"'`,
    multi: [{ open: /^`/, close: "`", esc: true }],
    kw: words(TS_KW),
    types: words("string number boolean any unknown never void object bigint symbol Record Partial Required Readonly Pick Omit Promise Array"),
    consts: words(JS_CONSTS),
    builtins: words(JS_BUILTINS),
    defAfter: words("function class interface type enum namespace"),
    ident: /^[A-Za-z_$][\w$]*/,
    dec: /^@[\w.]+/,
  },
  php: {
    label: "PHP",
    line: ["//", "#"],
    block: [["/*", "*/"]],
    quotes: `"'`,
    kw: words("abstract and as break case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile enum extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield"),
    types: words("int float string bool array object callable iterable mixed void never"),
    consts: words("true false null TRUE FALSE NULL"),
    builtins: words("count strlen str_replace explode implode array_map array_filter in_array json_encode json_decode var_dump print_r sprintf"),
    defAfter: words("function class interface trait enum"),
    vars: /^\$\w+/,
    dec: /^(<\?(php|=)?|\?>)/,
  },
  ruby: {
    label: "Ruby",
    line: ["#"],
    quotes: `"'`,
    kw: words("alias and begin break case class def defined? do else elsif end ensure for if in module next not or redo rescue retry return self super then undef unless until when while yield require require_relative include extend attr_accessor attr_reader attr_writer private public protected lambda proc"),
    consts: words("true false nil self"),
    builtins: words("puts print p gets raise loop each map select reject reduce times"),
    defAfter: words("def class module"),
    capsType: true,
    vars: /^(@@?|\$)\w+|^:\w+/,
  },
  lua: {
    label: "Lua",
    block: [["--[[", "]]"]],
    line: ["--"],
    quotes: `"'`,
    multi: [{ open: /^\[(=*)\[/, close: (m) => `]${m[1]}]` }],
    kw: words("and break do else elseif end for function goto if in local not or repeat return then until while"),
    consts: words("true false nil self"),
    builtins: words("print pairs ipairs type tostring tonumber require pcall error assert setmetatable getmetatable table string math io os select next"),
    defAfter: words("function"),
  },
  shell: {
    label: "Shell",
    line: ["#"],
    quotes: `"'`,
    kw: words(SH_KW),
    consts: words("true false"),
    builtins: words(SH_BUILTINS),
    vars: SH_VARS,
    ident: /^[A-Za-z_][\w-]*/,
  },
  sql: {
    label: "SQL",
    line: ["--"],
    block: [["/*", "*/"]],
    quotes: `'"`,
    kw: words(SQL_KW),
    types: words("int integer bigint smallint serial real float double decimal numeric varchar char text boolean bool date time timestamp blob json jsonb uuid"),
    consts: words("true false null"),
    builtins: words("count sum avg min max coalesce now length lower upper substr round cast"),
    nocase: true,
  },
  haskell: {
    label: "Haskell",
    line: ["--"],
    block: [["{-", "-}"]],
    quotes: `"'`,
    charLit: true,
    kw: words("case class data default deriving do else foreign if import in infix infixl infixr instance let module newtype of then type where qualified as hiding forall"),
    consts: words("True False Nothing Just Left Right otherwise"),
    builtins: words("map filter foldr foldl length head tail print putStrLn show read return pure fmap mapM_ concat zip"),
    capsType: true,
  },
  json: {
    label: "JSON",
    quotes: `"`,
    consts: words("true false null"),
    keyStrings: true,
  },
  yaml: {
    label: "YAML",
    line: ["#"],
    quotes: `"'`,
    consts: words("true false null yes no on off True False Null"),
    vars: /^[&*][\w-]+/,
    head: (line) => {
      const m = /^(\s*(?:-\s+)?)([\w.-]+|"[^"]*"|'[^']*')(\s*:)(?=\s|$)/.exec(line);
      if (m) return [esc(m[1]) + span("prop", m[2]) + esc(m[3]), m[0].length];
      const doc = /^(---|\.\.\.)\s*$/.exec(line);
      return doc ? [span("pre", doc[0]), doc[0].length] : undefined;
    },
  },
  toml: {
    label: "TOML",
    line: ["#", ";"],
    quotes: `"'`,
    multi: [{ open: /^("""|''')/, esc: true }],
    consts: words("true false"),
    head: (line) => {
      const sec = /^\s*\[\[?[^\]]*\]\]?/.exec(line);
      if (sec) return [span("def", sec[0]), sec[0].length];
      const m = /^(\s*)([\w.-]+|"[^"]*")(\s*=)/.exec(line);
      return m ? [esc(m[1]) + span("prop", m[2]) + esc(m[3]), m[0].length] : undefined;
    },
  },
  make: {
    label: "Makefile",
    line: ["#"],
    quotes: `"'`,
    kw: words("ifeq ifneq ifdef ifndef else endif include define endef export override"),
    builtins: words(SH_BUILTINS),
    vars: /^\$(\([^)]*\)|\{[^}]*\}|[@<^?*%+]|\w)/,
    ident: /^[A-Za-z_.][\w.-]*/,
    head: (line) => {
      const v = /^(\s*)([\w.-]+)(\s*(?:::|[:+?!])?=)/.exec(line);
      if (v) return [esc(v[1]) + span("prop", v[2]) + esc(v[3]), v[0].length];
      const r = /^([\w./%$(){}-]+(?:\s+[\w./%$(){}-]+)*)(\s*::?)(?!=)/.exec(line);
      return r ? [span("def", r[1]) + esc(r[2]), r[0].length] : undefined;
    },
  },
  docker: {
    label: "Dockerfile",
    line: ["#"],
    quotes: `"'`,
    builtins: words(SH_BUILTINS),
    vars: SH_VARS,
    head: (line) => {
      const m = /^(\s*)(FROM|RUN|CMD|LABEL|EXPOSE|ENV|ADD|COPY|ENTRYPOINT|VOLUME|USER|WORKDIR|ARG|ONBUILD|STOPSIGNAL|HEALTHCHECK|SHELL|AS)\b/i.exec(line);
      return m ? [esc(m[1]) + span("kw", m[2]), m[0].length] : undefined;
    },
  },
} satisfies Record<string, Spec>;

/** Linguaggi con un lexer proprio. */
const CUSTOM = { asm: "Assembly", html: "HTML", xml: "XML", css: "CSS", markdown: "Markdown" } as const;

export type Lang = keyof typeof SPECS | keyof typeof CUSTOM | "text";

const EXT: Record<string, Lang> = {
  py: "python", pyw: "python", pyi: "python",
  c: "c", h: "c",
  cpp: "cpp", cc: "cpp", cxx: "cpp", "c++": "cpp", hpp: "cpp", hh: "cpp", hxx: "cpp", ino: "cpp",
  cs: "csharp", java: "java", kt: "kotlin", kts: "kotlin", go: "go", rs: "rust", swift: "swift",
  js: "js", mjs: "js", cjs: "js", jsx: "js",
  ts: "ts", tsx: "ts", mts: "ts", cts: "ts",
  php: "php", rb: "ruby", lua: "lua",
  sh: "shell", bash: "shell", zsh: "shell", fish: "shell",
  sql: "sql", hs: "haskell",
  json: "json", jsonc: "json", yml: "yaml", yaml: "yaml", toml: "toml", ini: "toml", cfg: "toml", conf: "toml",
  mk: "make",
  asm: "asm", s: "asm", nasm: "asm",
  html: "html", htm: "html", vue: "html", svelte: "html",
  xml: "xml", svg: "xml", xsd: "xml", plist: "xml",
  css: "css", scss: "css", less: "css",
  md: "markdown", markdown: "markdown",
};

export function langOf(path: string): Lang {
  const name = path.split("/").pop() ?? "";
  if (/^(GNU)?makefile$/i.test(name)) return "make";
  if (/^(Dockerfile|Containerfile)(\..*)?$/i.test(name) || /\.dockerfile$/i.test(name)) return "docker";
  if (/^\.(bashrc|zshrc|profile|bash_profile)$/.test(name)) return "shell";
  const ext = /\.([^.]+)$/.exec(name)?.[1];
  if (!ext) return "text";
  return EXT[ext] ?? EXT[ext.toLowerCase()] ?? "text";
}

export function langLabel(lang: Lang): string {
  if (lang === "text") return t().msg.plainText;
  return lang in CUSTOM ? CUSTOM[lang as keyof typeof CUSTOM] : SPECS[lang as keyof typeof SPECS].label;
}

/** Il linguaggio scritto dopo ``` in Markdown (```c, ```python...). */
function langOfFence(name: string): Lang {
  const n = name.toLowerCase();
  const alias: Record<string, Lang> = { python: "python", javascript: "js", typescript: "ts", "c++": "cpp", "c#": "csharp", rust: "rust", golang: "go", bash: "shell", sh: "shell", shell: "shell", console: "shell", assembly: "asm", nasm: "asm", x86asm: "asm", haskell: "haskell", kotlin: "kotlin", ruby: "ruby", dockerfile: "docker", makefile: "make" };
  return alias[n] ?? EXT[n] ?? (n in SPECS || n in CUSTOM ? (n as Lang) : "text");
}

// ---------- Strumenti ----------

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const span = (cls: string, s: string) => (s ? `<span class="tk-${cls}">${esc(s)}</span>` : "");

/** Stato tra una riga e la successiva. */
interface State {
  /** Commento o stringa aperta: chiusura, classe, barra rovescia attiva. */
  end?: string;
  cls?: string;
  esc?: boolean;
  /** HTML: dentro un tag (attributi su più righe). */
  tag?: string;
  /** HTML: contenuto di <script> o <style>; Markdown: blocco di codice. */
  embed?: Lang;
  sub?: State | null;
  close?: string;
  /** CSS: profondità delle graffe. */
  depth?: number;
}

type Lexer = (line: string, state: State | null) => [string, State | null];

/** Indice subito dopo la chiusura, o -1 se la riga finisce prima. */
function findClose(line: string, from: number, close: string, backslash: boolean): number {
  for (let i = from; i <= line.length - close.length; i++) {
    if (backslash && line[i] === "\\") {
      i++;
      continue;
    }
    if (line.startsWith(close, i)) return i + close.length;
  }
  return -1;
}

/** Riprende un commento o una stringa lasciati aperti dalla riga prima. */
function resume(line: string, state: State): [string, number, State | null] {
  const end = findClose(line, 0, state.end!, !!state.esc);
  if (end === -1) return [span(state.cls!, line), line.length, state];
  return [span(state.cls!, line.slice(0, end)), end, null];
}

const NUM = /^(0[xX][0-9a-fA-F_']+|0[bB][01_']+|0[oO][0-7_]+|(\d[\d_']*)?\.?\d[\d_']*([eE][+-]?\d+)?)[a-zA-Z]*\d*/;

// ---------- Tokenizzatore generico ----------

function generic(spec: Spec): Lexer {
  const ident = spec.ident ?? /^[A-Za-z_]\w*/;
  const has = (set: Set<string> | undefined, w: string) => !!set && (set.has(w) || (spec.nocase === true && set.has(w.toLowerCase())));
  return (line, state) => {
    let out = "";
    let i = 0;
    if (state?.end) {
      const [html, n, next] = resume(line, state);
      if (next) return [html, next];
      out += html;
      i = n;
    }
    if (i === 0 && spec.head) {
      const h = spec.head(line);
      if (h) {
        out += h[0];
        i = h[1];
      }
    }
    if (i === 0 && spec.preproc) {
      const pre = /^\s*#\s*[a-z_]+/.exec(line);
      if (pre) {
        out += span("pre", pre[0]);
        i = pre[0].length;
        // #include <stdio.h>: il nome dell'intestazione come una stringa
        const hdr = /^\s*<[^>\n]*>/.exec(line.slice(i));
        if (hdr && /include|import/.test(pre[0])) {
          out += span("str", hdr[0]);
          i += hdr[0].length;
        }
      }
    }
    let prevWord = "";
    while (i < line.length) {
      const rest = line.slice(i);
      const ch = line[i];
      const before = line[i - 1] ?? " ";
      // commenti a blocchi (prima di quelli di riga: --[[ di Lua comincia come --)
      const blk = spec.block?.find(([open]) => rest.startsWith(open));
      if (blk) {
        const end = findClose(line, i + blk[0].length, blk[1], false);
        if (end === -1) return [out + span("com", rest), { end: blk[1], cls: "com" }];
        out += span("com", line.slice(i, end));
        i = end;
        continue;
      }
      // # chiude la riga solo se non è attaccato a una parola ($# della shell, a#b)
      if (spec.line?.some((c) => rest.startsWith(c) && (c !== "#" || /[\s;({[]/.test(before) || i === 0))) {
        out += span("com", rest);
        break;
      }
      if (spec.dec) {
        const d = spec.dec.exec(rest);
        if (d && (d[0][0] !== "@" || !/\w/.test(before))) {
          out += span("dec", d[0]);
          i += d[0].length;
          continue;
        }
      }
      const multi = spec.multi?.find((m) => m.open.test(rest));
      if (multi && !/\w/.test(before.replace(/[$@]/, ""))) {
        const m = rest.match(multi.open)!;
        const close = typeof multi.close === "function" ? multi.close(m) : (multi.close ?? m[1]);
        const cls = multi.cls ?? "str";
        const end = findClose(line, i + m[0].length, close, !!multi.esc);
        if (end === -1) return [out + span(cls, rest), { end: close, cls, esc: multi.esc }];
        out += span(cls, line.slice(i, end));
        i = end;
        continue;
      }
      if (spec.quotes?.includes(ch) || (spec === SPECS.python && /^[rbfuRBFU]{1,2}["']/.test(rest) && !/\w/.test(before))) {
        if (ch === "'" && spec.charLit) {
          const c = /^'(\\.[^']*|[^'\\])'/.exec(rest);
          if (!c) {
            // Rust: 'a è un lifetime; altrove un apostrofo isolato
            const life = /^'[A-Za-z_]\w*/.exec(rest);
            out += life ? span("type", life[0]) : esc(ch);
            i += life ? life[0].length : 1;
            continue;
          }
          out += span("str", c[0]);
          i += c[0].length;
          continue;
        }
        const pre = /^[rbfuRBFU]{0,2}/.exec(rest)![0];
        const q = rest[pre.length];
        let end = findClose(line, i + pre.length + 1, q, true);
        if (end === -1) end = line.length;
        const str = line.slice(i, end);
        const key = spec.keyStrings && /^\s*:/.test(line.slice(end));
        out += span(key ? "prop" : "str", str);
        i = end;
        continue;
      }
      if (spec.vars) {
        const v = spec.vars.exec(rest);
        if (v) {
          out += span("var", v[0]);
          i += v[0].length;
          continue;
        }
      }
      const num = NUM.exec(rest);
      if (num && /\d/.test(num[0]) && !/[\w.]/.test(before) && (ch !== "." || /\d/.test(rest[1] ?? ""))) {
        out += span("num", num[0]);
        i += num[0].length;
        continue;
      }
      const word = ident.exec(rest);
      if (word) {
        const w = word[0];
        const after = line.slice(i + w.length);
        let cls = "";
        if (spec.macros && after.startsWith("!") && !after.startsWith("!=")) {
          out += span("builtin", `${w}!`);
          prevWord = "";
          i += w.length + 1;
          continue;
        }
        if (has(spec.kw, w)) cls = "kw";
        else if (has(spec.types, w)) cls = "type";
        else if (has(spec.consts, w)) cls = "const";
        else if (spec.defAfter?.has(prevWord)) cls = "def";
        else if (/^[A-Z][A-Z0-9_]+$/.test(w)) cls = "const";
        else if (has(spec.builtins, w)) cls = "builtin";
        else if (/^\s*\(/.test(after)) cls = "call";
        else if (spec.capsType && /^[A-Z][a-z]\w*$/.test(w)) cls = "type";
        out += cls ? span(cls, w) : esc(w);
        prevWord = w;
        i += w.length;
        continue;
      }
      if (ch !== " " && ch !== "\t" && ch !== "*" && ch !== "&") prevWord = "";
      out += esc(ch);
      i++;
    }
    return [out, null];
  };
}

// ---------- Assembly (x86 NASM e GAS, ARM, RISC-V) ----------

const ASM_DIRECTIVES = words("section segment global globl extern bits default db dw dd dq dt resb resw resd resq times equ align org use16 use32 use64 struc endstruc istruc iend at incbin cpu");
const ASM_SIZES = words("byte word dword qword tword oword xmmword ymmword ptr near far short rel abs");
const ASM_REG =
  /^%?(?:[re]?[abcd]x|[abcd][lh]|[re]?(?:si|di|sp|bp|ip)|[sd]il|[sb]pl|r(?:[89]|1[0-5])[dwb]?|[c-gs]s|[re]?flags|cr[0-8]|dr[0-7]|[xyz]mm(?:[12]?\d|3[01])|st\(?\d?\)?|[xw](?:[12]?\d|3[01])|[xw]zr|sp|lr|pc|fp|zero|ra|gp|tp|[ast]\d{1,2}|r(?:1[0-5]|\d)|v\d{1,2}|[qdsbh]\d{1,2})$/i;

const asmLexer: Lexer = (line) => {
  let out = "";
  let i = 0;
  let mnemonic = false;
  const lead = /^\s*/.exec(line)![0];
  out += lead;
  i = lead.length;
  // etichetta: main:, .L1:, 1:
  const label = /^[\w.$@]+:/.exec(line.slice(i));
  if (label) {
    out += span("def", label[0]);
    i += label[0].length;
  }
  while (i < line.length) {
    const rest = line.slice(i);
    const ch = line[i];
    const before = line[i - 1] ?? " ";
    // commenti: ; (NASM), // e /* */, # a inizio istruzione o dopo uno spazio seguito da spazio (GAS), @ (ARM)
    if (ch === ";" || rest.startsWith("//") || (ch === "#" && (!mnemonic || /^#\s/.test(rest)) && /\s/.test(before === "" ? " " : before)) || (ch === "@" && /^@\s/.test(rest))) {
      out += span("com", rest);
      break;
    }
    if (rest.startsWith("/*")) {
      const end = findClose(line, i + 2, "*/", false);
      const stop = end === -1 ? line.length : end;
      out += span("com", line.slice(i, stop));
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      let end = findClose(line, i + 1, ch, true);
      if (end === -1) end = line.length;
      out += span("str", line.slice(i, end));
      i = end;
      continue;
    }
    // numeri: 0x10, $0x10, #16, 10h, 0b1010, 1f / 1b (etichette locali)
    const num = /^([$#]?-?(0[xX][0-9a-fA-F]+|0[bB][01]+|[0-9][0-9a-fA-F]*[hH]\b|\d+[fb]?\b))/.exec(rest);
    if (num && !/[\w.]/.test(before)) {
      out += span("num", num[0]);
      i += num[0].length;
      continue;
    }
    const word = /^(%?[A-Za-z_.][\w.$@]*|%\w+)/.exec(rest);
    if (word) {
      const w = word[0];
      const lw = w.toLowerCase();
      let cls = "";
      if (ASM_REG.test(w) && mnemonic) cls = "type";
      else if (!mnemonic && (w.startsWith(".") || w.startsWith("%") || ASM_DIRECTIVES.has(lw))) {
        cls = "pre";
        mnemonic = true;
      } else if (!mnemonic) {
        cls = "kw";
        mnemonic = true;
      } else if (ASM_SIZES.has(lw)) cls = "builtin";
      else if (ASM_DIRECTIVES.has(lw)) cls = "pre";
      else if (/^[A-Z][A-Z0-9_]+$/.test(w)) cls = "const";
      else cls = "call";
      out += span(cls, w);
      i += w.length;
      continue;
    }
    out += esc(ch);
    i++;
  }
  return [out, null];
};

// ---------- HTML e XML ----------

function markupLexer(xml: boolean): Lexer {
  return (line, state) => {
    let out = "";
    let i = 0;
    let st: State | null = state;
    while (i < line.length) {
      if (st?.embed) {
        // contenuto di <script> o <style>: colorato nel suo linguaggio fino al tag di chiusura
        const stop = line.toLowerCase().indexOf(st.close!, i);
        const part = line.slice(i, stop === -1 ? line.length : stop);
        const [html, sub] = LEXERS[st.embed](part, st.sub ?? null);
        out += html;
        if (stop === -1) return [out, { ...st, sub }];
        st = null;
        i = stop;
        continue;
      }
      if (st?.end) {
        const end = findClose(line, i, st.end, false);
        if (end === -1) return [out + span(st.cls!, line.slice(i)), st];
        out += span(st.cls!, line.slice(i, end));
        i = end;
        st = null;
        continue;
      }
      const rest = line.slice(i);
      const ch = line[i];
      if (st?.tag !== undefined) {
        const tagEnd = /^\/?>|^\?>/.exec(rest);
        if (tagEnd) {
          out += span("tag", tagEnd[0]);
          i += tagEnd[0].length;
          const name = st.tag.toLowerCase();
          if (!xml && tagEnd[0] === ">" && (name === "script" || name === "style")) {
            st = { embed: name === "script" ? "js" : "css", sub: null, close: `</${name}` };
          } else st = null;
          continue;
        }
        if (ch === '"' || ch === "'") {
          let end = findClose(line, i + 1, ch, false);
          if (end === -1) end = line.length;
          out += span("str", line.slice(i, end));
          i = end;
          continue;
        }
        const attr = /^[^\s=>/"']+/.exec(rest);
        if (attr) {
          out += span("attr", attr[0]);
          i += attr[0].length;
          continue;
        }
        out += esc(ch);
        i++;
        continue;
      }
      if (rest.startsWith("<!--")) {
        st = { end: "-->", cls: "com" };
        out += span("com", "<!--");
        i += 4;
        continue;
      }
      if (rest.startsWith("<![CDATA[")) {
        st = { end: "]]>", cls: "str" };
        out += span("pre", "<![CDATA[");
        i += 9;
        continue;
      }
      const decl = /^<[!?][^>]*>?/.exec(rest);
      if (decl) {
        out += span("pre", decl[0]);
        i += decl[0].length;
        continue;
      }
      const open = /^<\/?([A-Za-z][\w:.-]*)/.exec(rest);
      if (open) {
        out += span("tag", open[0]);
        i += open[0].length;
        st = { tag: open[0][1] === "/" ? "" : open[1] };
        continue;
      }
      const ent = /^&(#?\w+);/.exec(rest);
      if (ent) {
        out += span("const", ent[0]);
        i += ent[0].length;
        continue;
      }
      // testo: fino al prossimo < o &
      const text = /^[^<&]+/.exec(rest)?.[0] ?? ch;
      out += esc(text);
      i += text.length;
    }
    return [out, st];
  };
}

// ---------- CSS (anche SCSS e Less) ----------

const cssLexer: Lexer = (line, state) => {
  let out = "";
  let i = 0;
  let depth = state?.depth ?? 0;
  if (state?.end) {
    const [html, n, next] = resume(line, state);
    if (next) return [html, { ...next, depth }];
    out += html;
    i = n;
  }
  let inValue = false;
  /** Parentesi di una at-rule: @media (max-width: 760px). */
  let paren = 0;
  while (i < line.length) {
    const rest = line.slice(i);
    const ch = line[i];
    const before = line[i - 1] ?? " ";
    if (!inValue && (ch === "(" || ch === ")")) paren = Math.max(0, paren + (ch === "(" ? 1 : -1));
    if (rest.startsWith("/*")) {
      const end = findClose(line, i + 2, "*/", false);
      if (end === -1) return [out + span("com", rest), { end: "*/", cls: "com", depth }];
      out += span("com", line.slice(i, end));
      i = end;
      continue;
    }
    if (rest.startsWith("//") && before !== ":") {
      out += span("com", rest);
      break;
    }
    if (ch === '"' || ch === "'") {
      let end = findClose(line, i + 1, ch, true);
      if (end === -1) end = line.length;
      out += span("str", line.slice(i, end));
      i = end;
      continue;
    }
    if (ch === "{" || ch === "}") {
      depth = Math.max(0, depth + (ch === "{" ? 1 : -1));
      inValue = false;
      out += ch;
      i++;
      continue;
    }
    if (ch === ";" || (ch === ")" && paren > 0 && inValue && !/\(/.test(line.slice(0, i).split(":").pop() ?? ""))) {
      if (ch === ")") paren--;
      inValue = false;
      out += ch;
      i++;
      continue;
    }
    const at = /^@[\w-]+/.exec(rest);
    if (at) {
      out += span("kw", at[0]);
      i += at[0].length;
      continue;
    }
    const cvar = /^(--[\w-]+|\$[\w-]+)/.exec(rest);
    if (cvar && !/[\w-]/.test(before)) {
      out += span("var", cvar[0]);
      i += cvar[0].length;
      // --x: valore (dichiarazione di una variabile)
      const colon = /^\s*:(?!:)/.exec(line.slice(i));
      if (colon && !inValue) {
        out += esc(colon[0]);
        i += colon[0].length;
        inValue = true;
      }
      continue;
    }
    if (inValue) {
      const hex = /^#[0-9a-fA-F]{3,8}\b/.exec(rest);
      if (hex) {
        out += span("num", hex[0]);
        i += hex[0].length;
        continue;
      }
      const num = /^-?(\d*\.)?\d+(%|[a-zA-Z]+)?/.exec(rest);
      if (num && !/[\w-]/.test(before)) {
        out += span("num", num[0]);
        i += num[0].length;
        continue;
      }
      if (rest.startsWith("!important")) {
        out += span("kw", "!important");
        i += 10;
        continue;
      }
      const w = /^[A-Za-z_-][\w-]*/.exec(rest);
      if (w) {
        out += /^\(/.test(line.slice(i + w[0].length)) ? span("call", w[0]) : span("const", w[0]);
        i += w[0].length;
        continue;
      }
      out += esc(ch);
      i++;
      continue;
    }
    // dentro le graffe: "proprietà:" seguita da un valore (non un selettore annidato con {)
    const prop = /^([A-Za-z-][\w-]*)(\s*:)(?!:)/.exec(rest);
    if (prop && (depth > 0 || paren > 0) && !/^[^;]*\{/.test(rest.replace(/\)[^)]*$/, ""))) {
      out += span("prop", prop[1]) + esc(prop[2]);
      i += prop[0].length;
      inValue = true;
      continue;
    }
    // selettori
    const sel = /^([.#][\w-]+|::?[\w-]+|&)/.exec(rest);
    if (sel) {
      out += span(sel[0][0] === ":" ? "kw" : "def", sel[0]);
      i += sel[0].length;
      continue;
    }
    const tag = /^[A-Za-z][\w-]*/.exec(rest);
    if (tag) {
      out += span("tag", tag[0]);
      i += tag[0].length;
      continue;
    }
    out += esc(ch);
    i++;
  }
  return [out, depth ? { depth } : null];
};

// ---------- Markdown ----------

const markdownLexer: Lexer = (line, state) => {
  if (state?.embed) {
    if (/^\s*(```|~~~)\s*$/.test(line)) return [span("pre", line), null];
    const [html, sub] = LEXERS[state.embed](line, state.sub ?? null);
    return [html, { ...state, sub }];
  }
  const fence = /^\s*(```|~~~)\s*([\w+#-]*)/.exec(line);
  if (fence) return [span("pre", line), { embed: langOfFence(fence[2]), sub: null }];
  if (/^#{1,6}\s/.test(line)) return [span("kw", line), null];
  if (/^\s*>/.test(line)) return [span("com", line), null];
  if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return [span("pre", line), null];
  let out = "";
  let i = 0;
  const bullet = /^\s*([-*+]|\d+[.)])\s/.exec(line);
  if (bullet) {
    out += span("num", bullet[0]);
    i = bullet[0].length;
  }
  while (i < line.length) {
    const rest = line.slice(i);
    const code = /^`[^`]+`/.exec(rest);
    if (code) {
      out += span("str", code[0]);
      i += code[0].length;
      continue;
    }
    const bold = /^(\*\*|__)(?=\S)(.+?)\1/.exec(rest);
    if (bold) {
      out += span("const", bold[0]);
      i += bold[0].length;
      continue;
    }
    const link = /^!?\[([^\]]*)\]\(([^)]*)\)/.exec(rest);
    if (link) {
      const text = link[0].slice(0, link[0].indexOf("](") + 2);
      out += span("def", text) + span("call", link[2]) + ")";
      i += link[0].length;
      continue;
    }
    const plain = /^[^`*_![]+/.exec(rest)?.[0] ?? line[i];
    out += esc(plain);
    i += plain.length;
  }
  return [out, null];
};

// ---------- Ingresso ----------

const plain: Lexer = (line) => [esc(line), null];

const LEXERS: Record<Lang, Lexer> = {
  ...(Object.fromEntries(Object.entries(SPECS).map(([k, s]) => [k, generic(s)])) as Record<keyof typeof SPECS, Lexer>),
  asm: asmLexer,
  html: markupLexer(false),
  xml: markupLexer(true),
  css: cssLexer,
  markdown: markdownLexer,
  text: plain,
};

/** Evidenzia tutte le righe di un file; commenti, stringhe e blocchi possono continuare sulla riga dopo. */
export function highlightLines(source: string, lang: Lang): string[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const lex = LEXERS[lang] ?? plain;
  let state: State | null = null;
  return lines.map((line) => {
    const [html, next] = lex(line, state);
    state = next;
    return html;
  });
}
