"""Lists, for the Python files named on stdin (one path per line, relative to the repository given
as the first argument), where each function and class is defined and where each call and import
name is written. Columns are counted in UTF-16 units, as the language server protocol counts them. scripts/recall-python.mjs asks a type checker what those calls and names refer to.
Prints one JSON object per file. Uses only the standard library; nothing of the repository is run."""
import ast
import json
import re
import sys

root = sys.argv[1]


def units(text):
    """The length of a piece of text in UTF-16 code units."""
    return len(text.encode("utf-16-le")) // 2


class Visitor(ast.NodeVisitor):
    def __init__(self, lines):
        self.lines = lines
        self.raw = [line.encode("utf-8") for line in lines]
        self.scope = []  # (kind, name) of the enclosing classes and functions
        self.defs = []
        self.calls = []
        self.names = []

    def column(self, line, offset):
        """A column of Python's parser, which counts UTF-8 bytes, as one in UTF-16 units."""
        return units(self.raw[line - 1][:offset].decode("utf-8", "ignore")) if line <= len(self.raw) else offset

    def symbol(self):
        """The enclosing definition as atlas names it: `f`, `C` or `C.m`; None inside anything deeper."""
        if not self.scope:
            return ""
        kinds = [kind for kind, _ in self.scope]
        names = [name for _, name in self.scope]
        if kinds[0] == "function":
            return names[0]
        if len(kinds) >= 2 and kinds[1] == "function":
            return names[0] + "." + names[1]
        return names[0]

    def define(self, node, kind):
        kinds = [k for k, _ in self.scope]
        if not kinds:
            shape, name = ("class" if kind == "class" else "function"), node.name
        elif kinds == ["class"] and kind == "function":
            shape, name = "method", self.scope[0][1] + "." + node.name
        elif "function" in kinds:
            # Named so that it can never be taken for a top-level symbol of the same name.
            shape, name = "defined inside a function", (self.symbol() or "") + ".<locals>." + node.name
        else:
            shape, name = "nested class or its method", ".".join(n for _, n in self.scope) + "." + node.name
        # The name comes after `def`, `async def` or `class`, on the line the statement starts (decorators have their own lines).
        text = self.lines[node.lineno - 1] if node.lineno <= len(self.lines) else ""
        found = re.search(r"\b(?:def|class)\s+(" + re.escape(node.name) + r")\b", text)
        col = units(text[: found.start(1)]) if found else self.column(node.lineno, node.col_offset)
        self.defs.append({"line": node.lineno, "col": col, "name": name, "shape": shape, "plain": node.name})
        self.scope.append((kind, node.name))
        self.generic_visit(node)
        self.scope.pop()

    def visit_FunctionDef(self, node):
        self.define(node, "function")

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_ClassDef(self, node):
        self.define(node, "class")

    def visit_Call(self, node):
        func = node.func
        if isinstance(func, ast.Name):
            self.calls.append({"line": func.lineno, "col": self.column(func.lineno, func.col_offset), "form": "name()", "around": self.symbol()})
        elif isinstance(func, ast.Attribute) and func.end_lineno is not None:
            value = func.value
            if isinstance(value, ast.Name) and value.id in ("self", "cls"):
                form = "self.method()"
            elif isinstance(value, ast.Name):
                form = "name.method()"
            elif isinstance(value, ast.Call):
                form = "call().method()"
            else:
                form = "a.b.method()"
            self.calls.append({"line": func.end_lineno, "col": self.column(func.end_lineno, func.end_col_offset) - units(func.attr), "form": form, "around": self.symbol()})
        self.generic_visit(node)

    def imported(self, node):
        # Python 3.9 gives no position for an imported name, so it is found in the text of the statement.
        end = node.end_lineno or node.lineno
        for alias in node.names:
            last = alias.name.split(".")[-1]
            if last == "*":
                continue
            for number in range(node.lineno, end + 1):
                text = self.lines[number - 1]
                start = text.find("import") + 6 if number == node.lineno and isinstance(node, ast.ImportFrom) else 0
                found = re.search(r"(?<![\w.])" + re.escape(alias.name) + r"\b", text[start:])
                if found:
                    # `import a.b` names a module. `from a import b` names one only if `b` is a file of `a`, which the checker says.
                    self.names.append({"line": number, "col": units(text[: start + found.start() + len(alias.name) - len(last)]), "module": isinstance(node, ast.Import), "last": last})
                    break

    def visit_Import(self, node):
        self.imported(node)

    def visit_ImportFrom(self, node):
        self.imported(node)
        if node.module:
            text = self.lines[node.lineno - 1]
            found = re.search(r"\bfrom\s+(\.*" + re.escape(node.module) + r")\b", text)
            if found:
                self.names.append({"line": node.lineno, "col": units(text[: found.end(1) - len(node.module.split(".")[-1])]), "module": True, "last": node.module.split(".")[-1]})


print(json.dumps({"python": sys.version.split()[0]}))
for path in sys.stdin.read().split("\n"):
    if not path:
        continue
    try:
        with open(root + "/" + path, encoding="utf-8") as handle:
            source = handle.read()
        tree = ast.parse(source)
    except (OSError, SyntaxError, UnicodeDecodeError, ValueError):
        print(json.dumps({"file": path, "failed": True}))
        continue
    visitor = Visitor(source.split("\n"))
    visitor.visit(tree)
    print(json.dumps({"file": path, "defs": visitor.defs, "calls": visitor.calls, "names": visitor.names}))
