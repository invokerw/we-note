package store

import (
	"strings"
	"testing"
)

func TestPortableMarkdownChangesOnlySharedAssetDestinations(t *testing.T) {
	const src = "https://notes.example.org/assets/asset_123"
	const relative = "../../../assets/asset_123/%E5%9B%BE%20%28a%29%23%25.png"
	assets := map[string]string{src: "assets/asset_123/图 (a)#%.png"}
	for _, tc := range []struct{ name, input, want string }{
		{"image and title", `![diagram](URL "URL")`, `![diagram](REL "URL")`},
		{"reference", "[view][a]\r\n\r\n[a]:\r\n  <URL#page=3> 'URL'", "[view][a]\r\n\r\n[a]:\r\n  <REL#page=3> 'URL'"},
		{"nested image", `[![i](URL)](URL?download=1)`, `[![i](REL)](REL?download=1)`},
		{"autolinks", `<URL> and URL.`, `[图 (a)#%.png](<REL>) and [图 (a)#%.png](<REL>).`},
		{"frontmatter and code", "\ufeff---\r\nprop: URL\r\n---\r\n\r\n`[x](URL)`\r\n\r\n~~~md\r\n![x](URL)\r\n~~~\r\n\r\n> [x](URL)\r\n", "\ufeff---\r\nprop: URL\r\n---\r\n\r\n`[x](URL)`\r\n\r\n~~~md\r\n![x](URL)\r\n~~~\r\n\r\n> [x](REL)\r\n"},
		{"other destinations", `[x](URLmore) [x](URL/subpath) [x](https://other.invalid/?q=URL) [x](folder/a.md)`, `[x](URLmore) [x](URL/subpath) [x](https://other.invalid/?q=URL) [x](folder/a.md)`},
		{"indented list", "- parent\n\n\t- [x](<URL>)", "- parent\n\n\t- [x](<REL>)"},
		{"table", "| col |\n| --- |\n| [x](URL) |", "| col |\n| --- |\n| [x](REL) |"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			replace := strings.NewReplacer("URL", src, "REL", relative)
			var got strings.Builder
			n, e := writePortableMarkdown(&got, []byte(replace.Replace(tc.input)), "notes/a/b/note.MD", assets)
			if e != nil || int64(got.Len()) != n || got.String() != replace.Replace(tc.want) {
				t.Fatalf("got %q (%d, %v)\nwant %q", got.String(), n, e, replace.Replace(tc.want))
			}
		})
	}
}

func TestPortableBareLinkToSelfHostedVault(t *testing.T) {
	for _, host := range []string{"localhost:8443", "127.0.0.1:9443"} {
		url := "https://" + host + "/assets/asset_123"
		var got strings.Builder
		_, err := writePortableMarkdown(&got, []byte(url), "notes/n.md", map[string]string{url: "assets/asset_123/pdf.pdf"})
		if err != nil || got.String() != "[pdf.pdf](<../assets/asset_123/pdf.pdf>)" {
			t.Fatalf("%s: %q, %v", host, got.String(), err)
		}
	}
}
