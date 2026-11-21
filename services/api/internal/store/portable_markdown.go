package store

import (
	"bytes"
	"io"
	"net/url"
	"path"
	"regexp"
	"sort"
	"strings"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/text"
)

// A self-hosted vault may use a single-label host or an IP address. Goldmark's
// default bare-URL matcher requires a domain with an alphabetic suffix.
var absoluteURL = regexp.MustCompile(`^https?://[a-zA-Z0-9.-]+(?::[0-9]+)?(?:[/?#][-a-zA-Z0-9._~!$&'()*+,;=:@/%?#\[\]]*)?`)
var exportMarkdown = goldmark.New(goldmark.WithExtensions(extension.Table, extension.Strikethrough,
	extension.NewLinkify(extension.WithLinkifyURLRegexp(absoluteURL))))
var escapeLinkLabel = strings.NewReplacer(`\`, `\\`, `[`, `\[`, `]`, `\]`, `*`, `\*`, `_`, `\_`, "`", "\\`", `~`, `\~`, `$`, `\$`)
var yamlHeader = regexp.MustCompile(`(?ms)\A---[ \t]*\r?\n.*?^(?:---|\.\.\.)[ \t]*\r?(?:\n|\z)`)

// Use the parser's destination slices to locate links in the original bytes.
// The same URL may also occur in code, titles and link labels. Re-serializing
// the syntax tree would discard the author's formatting and line endings.
func writePortableMarkdown(w io.Writer, source []byte, notePath string, assets map[string]string) (int64, error) {
	if !bytes.Contains(source, []byte("/assets/")) {
		n, err := w.Write(source)
		return int64(n), err
	}
	body := bytes.TrimPrefix(source, []byte("\uFEFF"))
	if header := yamlHeader.FindIndex(body); header != nil {
		body = body[header[1]:]
	}
	offsets := map[*byte]int{}
	for start := 0; start < len(body); {
		i := bytes.Index(body[start:], []byte("https://"))
		if i < 0 {
			break
		}
		start += i
		offsets[&body[start]] = len(source) - len(body) + start
		start += len("https://")
	}
	if len(offsets) == 0 {
		n, err := w.Write(source)
		return int64(n), err
	}
	type edit struct {
		end    int
		asset  string
		suffix string
		auto   bool
	}
	edits := map[int]edit{}
	// All note entries live under notes/ and all attachments under assets/.
	prefix := strings.Repeat("../", strings.Count(notePath, "/"))
	add := func(dest []byte, auto bool) {
		if len(dest) == 0 {
			return
		}
		start, ok := offsets[&dest[0]]
		if !ok {
			return
		}
		raw := string(dest)
		base, suffix := raw, ""
		if i := strings.IndexAny(raw, "?#"); i >= 0 {
			base, suffix = raw[:i], raw[i:]
		}
		asset, ok := assets[base]
		if !ok {
			return
		}
		end := start + len(dest)
		if auto && start > 0 && end < len(source) && source[start-1] == '<' && source[end] == '>' {
			start--
			end++
		}
		edits[start] = edit{end: end, asset: asset, suffix: suffix, auto: auto}
	}
	pc := parser.NewContext()
	doc := exportMarkdown.Parser().Parse(text.NewReader(body), parser.WithContext(pc))
	for _, ref := range pc.References() {
		add(ref.Destination(), false)
	}
	ast.Walk(doc, func(n ast.Node, enter bool) (ast.WalkStatus, error) {
		if enter {
			switch v := n.(type) {
			case *ast.Link:
				add(v.Destination, false)
			case *ast.Image:
				add(v.Destination, false)
			case *ast.AutoLink:
				add(v.URL(body), true)
			}
		}
		return ast.WalkContinue, nil
	})
	if len(edits) == 0 {
		n, err := w.Write(source)
		return int64(n), err
	}
	starts := make([]int, 0, len(edits))
	for k := range edits {
		starts = append(starts, k)
	}
	sort.Ints(starts)
	var size int64
	cursor := 0
	for _, start := range starts {
		e := edits[start]
		n, err := w.Write(source[cursor:start])
		if err != nil {
			return 0, err
		}
		size += int64(n)
		parts := strings.Split(e.asset, "/")
		for i, s := range parts {
			parts[i] = url.PathEscape(s)
		}
		replacement := prefix + strings.Join(parts, "/") + e.suffix
		if e.auto {
			label := escapeLinkLabel.Replace(path.Base(e.asset))
			replacement = "[" + label + "](<" + replacement + ">)"
		}
		n, err = io.WriteString(w, replacement)
		if err != nil {
			return 0, err
		}
		size += int64(n)
		cursor = e.end
	}
	n, err := w.Write(source[cursor:])
	return size + int64(n), err
}
