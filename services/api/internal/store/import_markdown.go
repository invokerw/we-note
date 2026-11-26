package store

import (
	"bytes"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/text"
	"net/url"
	"path"
	"sort"
	"strings"
)

// Keep the exported Markdown bytes outside parsed destinations, including line endings.
func importMarkdown(src []byte, file, folder string, assets map[string]string, notes map[string]bool, used map[string]bool, warnings map[string]bool) []byte {
	body := bytes.TrimPrefix(src, []byte("\uFEFF"))
	if h := yamlHeader.FindIndex(body); h != nil {
		body = body[h[1]:]
	}
	pc := parser.NewContext()
	doc := exportMarkdown.Parser().Parse(text.NewReader(body), parser.WithContext(pc))
	edits := map[*byte]struct {
		size  int
		value string
	}{}
	add := func(dest []byte, wiki bool) {
		if len(dest) == 0 {
			return
		}
		raw := string(dest)
		base, suffix := raw, ""
		if i := strings.IndexAny(raw, "?#"); i >= 0 {
			base, suffix = raw[:i], raw[i:]
		}
		name, e := url.PathUnescape(base)
		if e != nil || name == "" || strings.HasPrefix(name, "//") || strings.Contains(name, ":") {
			return
		}
		archived := path.Join(path.Dir(file), name)
		replacement, ok := assets[archived]
		if ok && !strings.HasPrefix(name, "/") {
			used[archived] = true
		} else {
			if folder == "" {
				return
			}
			target := strings.TrimPrefix(name, "/")
			if path.Ext(target) == "" {
				target += ".md"
			}
			if !strings.HasPrefix(name, "/") && notes[path.Join(path.Dir(strings.TrimPrefix(file, "notes/")), target)] {
				return
			}
			if !notes[target] {
				matches := 0
				for p := range notes {
					if path.Base(p) == target {
						replacement = p
						matches++
					}
				}
				if matches != 1 {
					if matches > 1 {
						warnings[file+" → "+name] = true
					}
					return
				}
				target = replacement
			}
			replacement = "/" + path.Join(folder, target)
			if !wiki {
				u := url.URL{Path: replacement}
				replacement = u.EscapedPath()
			}
		}
		edits[&dest[0]] = struct {
			size  int
			value string
		}{len(dest), replacement + suffix}
	}
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
			case *ast.Text:
				// Goldmark can split the brackets in a wiki link across adjacent text nodes.
				if folder == "" || n.Parent().Kind() == ast.KindCodeSpan || n.Parent().Kind() == ast.KindLink || n.Parent().Kind() == ast.KindImage {
					break
				}
				if prev, ok := v.PreviousSibling().(*ast.Text); ok && prev.Segment.Stop == v.Segment.Start {
					break
				}
				end := v.Segment.Stop
				for next := v.NextSibling(); next != nil; next = next.NextSibling() {
					part, ok := next.(*ast.Text)
					if !ok || part.Segment.Start != end {
						break
					}
					end = part.Segment.Stop
				}
				segment := body[v.Segment.Start:end]
				for _, m := range wikiPattern.FindAllSubmatchIndex(segment, -1) {
					add(segment[m[2]:m[3]], true)
				}
			}
		}
		return ast.WalkContinue, nil
	})
	if len(edits) == 0 {
		return src
	}
	var out bytes.Buffer
	start := 0
	for i := 0; i < len(src); i++ {
		if e, ok := edits[&src[i]]; ok {
			out.Write(src[start:i])
			out.WriteString(e.value)
			i += e.size - 1
			start = i + 1
		}
	}
	out.Write(src[start:])
	return out.Bytes()
}

func sortedImportKeys(values map[string]bool) []string {
	keys := make([]string, 0, len(values))
	for k := range values {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
