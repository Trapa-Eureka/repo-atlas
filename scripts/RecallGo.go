// Asks the Go type checker what every call and every name of another package refers to in a
// repository, and prints one line for each that leads to a declaration in that repository.
// Used by recall-go.mjs.
//
//	go run scripts/RecallGo.go <repository>
//
// `go list` finds the packages (and fetches the sources of the modules they need); nothing is
// built or run. Every package is type-checked from source, the standard library included.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"go/types"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

type listed struct {
	ImportPath  string
	Dir         string
	Name        string
	ForTest     string
	GoFiles     []string
	CgoFiles    []string
	TestGoFiles []string
	ImportMap   map[string]string
	Standard    bool
}

var (
	fset     = token.NewFileSet()
	packages = map[string]*listed{}
	checked  = map[string]*types.Package{}
	infos    = map[string]*types.Info{}
	parsed   = map[string][]*ast.File{}
	root     string
)

type importer struct{ from *listed }

func (i importer) Import(path string) (*types.Package, error) {
	if path == "unsafe" {
		return types.Unsafe, nil
	}
	if mapped, ok := i.from.ImportMap[path]; ok {
		path = mapped
	}
	if pkg := check(path); pkg != nil {
		return pkg, nil
	}
	return nil, fmt.Errorf("package %s not listed", path)
}

func inRepo(dir string) bool {
	return dir == root || strings.HasPrefix(dir, root+string(filepath.Separator))
}

func check(path string) *types.Package {
	if pkg, done := checked[path]; done {
		return pkg
	}
	item := packages[path]
	if item == nil {
		return nil
	}
	checked[path] = nil // an import cycle (possible between test variants) ends here
	names := append(append([]string{}, item.GoFiles...), item.CgoFiles...)
	seen := map[string]bool{}
	var files []*ast.File
	for _, name := range names {
		if seen[name] {
			continue
		}
		seen[name] = true
		file, _ := parser.ParseFile(fset, filepath.Join(item.Dir, name), nil, parser.SkipObjectResolution)
		if file != nil {
			files = append(files, file)
		}
	}
	info := &types.Info{Uses: map[*ast.Ident]types.Object{}, Selections: map[*ast.SelectorExpr]*types.Selection{}}
	config := types.Config{Importer: importer{item}, Error: func(error) {}, FakeImportC: true}
	// Only the packages of the repository are read afterwards; the others need their exported API only.
	config.IgnoreFuncBodies = !inRepo(item.Dir)
	pkg, _ := config.Check(strings.Fields(item.ImportPath)[0], fset, files, info)
	checked[path] = pkg
	if inRepo(item.Dir) {
		infos[path] = info
		parsed[path] = files
	}
	return pkg
}

func relative(pos token.Pos) (string, int, bool) {
	at := fset.Position(pos)
	if !at.IsValid() || !inRepo(filepath.Dir(at.Filename)) {
		return "", 0, false
	}
	file, _ := filepath.Rel(root, at.Filename)
	return filepath.ToSlash(file), at.Line, true
}

// `Type.Method` or `Func`, the way atlas names a Go symbol.
func nameOf(fn *types.Func) (string, string) {
	fn = fn.Origin()
	signature, _ := fn.Type().(*types.Signature)
	if signature == nil || signature.Recv() == nil {
		return fn.Name(), "function"
	}
	receiver := signature.Recv().Type()
	if pointer, ok := receiver.(*types.Pointer); ok {
		receiver = pointer.Elem()
	}
	named, ok := receiver.(*types.Named)
	if !ok {
		return fn.Name(), "method of an unnamed type"
	}
	if types.IsInterface(named) {
		return named.Obj().Name() + "." + fn.Name(), "interface method"
	}
	return named.Obj().Name() + "." + fn.Name(), "method"
}

func main() {
	root, _ = filepath.Abs(os.Args[1])
	root, _ = filepath.EvalSymlinks(root)
	command := exec.Command("go", "list", "-e", "-json", "-deps", "-test", "./...")
	command.Dir = root
	command.Stderr = io.Discard
	out, _ := command.Output()
	decoder := json.NewDecoder(bytes.NewReader(out))
	var order []string
	for {
		item := &listed{}
		if err := decoder.Decode(item); err != nil {
			break
		}
		// The synthesized test main (`p.test`) has no source of its own.
		if strings.HasSuffix(item.ImportPath, ".test") {
			continue
		}
		packages[item.ImportPath] = item
		order = append(order, item.ImportPath)
	}
	out2 := os.Stdout
	done := map[string]bool{}
	unresolved, external, values := 0, 0, 0
	for _, path := range order {
		item := packages[path]
		if !inRepo(item.Dir) {
			continue
		}
		check(path)
		info := infos[path]
		for _, file := range parsed[path] {
			from, _, _ := relative(file.Pos())
			// A file is in both `p` and `p [p.test]`: read it once, in the variant that has the tests.
			variant := from + "\x00" + fmt.Sprint(strings.Contains(path, " ["))
			if done[from] && !strings.Contains(path, " [") || done[variant] {
				continue
			}
			done[from], done[variant] = true, true

			// names of other packages of the repository: which of their files this one depends on
			for ident, object := range info.Uses {
				if ident.Pos() < file.Pos() || ident.Pos() > file.End() || object.Pkg() == nil {
					continue
				}
				if _, isPackageName := object.(*types.PkgName); isPackageName {
					continue
				}
				to, _, ok := relative(object.Pos())
				if ok && filepath.Dir(to) != filepath.Dir(from) && object.Parent() == object.Pkg().Scope() {
					fmt.Fprintf(out2, "I\t%s\t%s\n", from, to)
				}
			}

			var around []string
			ast.Inspect(file, func(node ast.Node) bool {
				if decl, ok := node.(*ast.FuncDecl); ok {
					name := decl.Name.Name
					if decl.Recv != nil && len(decl.Recv.List) > 0 {
						receiver := decl.Recv.List[0].Type
						if star, ok := receiver.(*ast.StarExpr); ok {
							receiver = star.X
						}
						if index, ok := receiver.(*ast.IndexExpr); ok {
							receiver = index.X
						}
						if index, ok := receiver.(*ast.IndexListExpr); ok {
							receiver = index.X
						}
						if ident, ok := receiver.(*ast.Ident); ok {
							name = ident.Name + "." + name
						}
					}
					around = []string{name}
					return true
				}
				call, ok := node.(*ast.CallExpr)
				if !ok {
					return true
				}
				fun := ast.Unparen(call.Fun)
				if index, ok := fun.(*ast.IndexExpr); ok {
					fun = index.X
				}
				if index, ok := fun.(*ast.IndexListExpr); ok {
					fun = index.X
				}
				var ident *ast.Ident
				form := "name()"
				switch callee := fun.(type) {
				case *ast.Ident:
					ident = callee
				case *ast.SelectorExpr:
					ident = callee.Sel
					form = "chained a.b().c() or a.b.c()"
					if object, ok := callee.X.(*ast.Ident); ok {
						switch info.Uses[object].(type) {
						case *types.PkgName:
							form = "pkg.Func()"
						case *types.Var:
							form = "variable.method()"
						case *types.TypeName:
							form = "Type.method()"
						}
					}
				default:
					values++ // a call of a call, a function literal called in place
					return true
				}
				switch object := info.Uses[ident].(type) {
				case *types.Func:
					to, _, ok := relative(object.Pos())
					if !ok {
						external++
						return true
					}
					name, shape := nameOf(object)
					if selection := info.Selections[selectorOf(fun)]; selection != nil && len(selection.Index()) > 1 && form == "variable.method()" {
						form = "variable.method() of an embedded type"
					}
					in := "-"
					if len(around) > 0 {
						in = around[0]
					}
					fmt.Fprintf(out2, "C\t%s\t%s\t%s\t%s\t%s\t%d\t%s\n", from, to, name, shape, form, fset.Position(call.Pos()).Line, in)
				case *types.Var:
					values++ // a function kept in a variable, a field or a parameter
				case *types.TypeName, *types.Builtin, *types.Nil:
					// a conversion or a builtin: not a call of anything declared
				default:
					unresolved++
				}
				return true
			})
		}
	}
	fmt.Fprintf(out2, "U\t%d\t%d\t%d\n", unresolved, external, values)
}

func selectorOf(expr ast.Expr) *ast.SelectorExpr {
	selector, _ := expr.(*ast.SelectorExpr)
	return selector
}
