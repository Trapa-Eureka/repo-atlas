// Asks javac what every call and every class name in a set of Java files refers to, and prints one
// line for each that leads to another declaration in those files. Used by recall-java.mjs.
//
//   java scripts/RecallJava.java <repository> <file with repository-relative paths, one per line>
//
// The repository is not built and its dependencies are not on the class path, so javac reports
// many errors. They are ignored: what it cannot resolve is counted as unresolved and left out.
import com.sun.source.tree.ClassTree;
import com.sun.source.tree.CompilationUnitTree;
import com.sun.source.tree.ExpressionTree;
import com.sun.source.tree.IdentifierTree;
import com.sun.source.tree.MemberSelectTree;
import com.sun.source.tree.MethodInvocationTree;
import com.sun.source.tree.MethodTree;
import com.sun.source.tree.NewClassTree;
import com.sun.source.tree.Tree;
import com.sun.source.tree.VariableTree;
import com.sun.source.util.JavacTask;
import com.sun.source.util.TreePath;
import com.sun.source.util.TreePathScanner;
import com.sun.source.util.Trees;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import javax.lang.model.element.Element;
import javax.lang.model.element.ElementKind;
import javax.lang.model.element.ExecutableElement;
import javax.lang.model.element.TypeElement;
import javax.lang.model.type.TypeKind;
import javax.tools.JavaCompiler;
import javax.tools.StandardJavaFileManager;
import javax.tools.ToolProvider;

public class RecallJava {
  static Path repo;
  static Trees trees;
  static int unresolved = 0;
  static int external = 0;

  public static void main(String[] args) throws Exception {
    repo = Path.of(args[0]).toRealPath();
    List<Path> paths = new ArrayList<>();
    for (String line : Files.readAllLines(Path.of(args[1]))) {
      // A module descriptor would put every other file in a module whose requirements are missing.
      if (!line.isBlank() && !line.endsWith("module-info.java")) paths.add(repo.resolve(line));
    }
    JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
    StandardJavaFileManager files = compiler.getStandardFileManager(diagnostic -> {}, null, null);
    // No annotation processors run, nothing is written, and attribution goes on after errors.
    List<String> options = List.of("-proc:none", "-Xlint:none", "-implicit:none", "-XDshould-stop.ifError=FLOW", "-XDshould-stop.ifNoError=FLOW");
    JavacTask task = (JavacTask) compiler.getTask(null, files, diagnostic -> {}, options, null, files.getJavaFileObjectsFromPaths(paths));
    trees = Trees.instance(task);
    List<CompilationUnitTree> units = new ArrayList<>();
    for (CompilationUnitTree unit : task.parse()) units.add(unit);
    try {
      task.analyze();
    } catch (RuntimeException | AssertionError failure) {
      System.err.println("javac stopped early: " + failure);
    }
    for (CompilationUnitTree unit : units) new Reader(unit).scan(unit, null);
    System.out.println("U\t" + unresolved + "\t" + external);
  }

  static String fileOf(CompilationUnitTree unit) {
    return repo.relativize(Path.of(unit.getSourceFile().toUri()).toAbsolutePath()).toString().replace('\\', '/');
  }

  /** The repository file that declares an element, or null when it comes from outside or from nowhere (an implicit member). */
  static String declaredIn(Element element) {
    TreePath path = element == null ? null : trees.getPath(element);
    return path == null ? null : fileOf(path.getCompilationUnit());
  }

  /** `Outer.Inner` for a class that atlas can name, null for an anonymous or local one. */
  static String className(Element type) {
    String name = "";
    for (Element at = type; at != null && at.getKind() != ElementKind.PACKAGE && at.getKind() != ElementKind.MODULE; at = at.getEnclosingElement()) {
      if (!(at instanceof TypeElement) || at.getSimpleName().isEmpty()) return null;
      name = name.isEmpty() ? at.getSimpleName().toString() : at.getSimpleName() + "." + name;
    }
    return name.isEmpty() ? null : name;
  }

  static boolean isClass(Element element) {
    return element instanceof TypeElement && element.asType().getKind() != TypeKind.ERROR && (element.getKind().isClass() || element.getKind().isInterface());
  }

  static class Reader extends TreePathScanner<Void, Void> {
    final CompilationUnitTree unit;
    final String from;

    Reader(CompilationUnitTree unit) {
      this.unit = unit;
      this.from = fileOf(unit);
    }

    long lineOf(Tree tree) {
      return unit.getLineMap().getLineNumber(trees.getSourcePositions().getStartPosition(unit, tree));
    }

    /** The symbol atlas would say the code at the current place is in: the method around it, else the class, when either has a name. */
    String around() {
      for (TreePath path = getCurrentPath(); path != null; path = path.getParentPath()) {
        Tree tree = path.getLeaf();
        if (!(tree instanceof MethodTree) && !(tree instanceof ClassTree)) continue;
        Element element = trees.getElement(path);
        Element owner = tree instanceof MethodTree ? (element == null ? null : element.getEnclosingElement()) : element;
        String name = owner == null ? null : className(owner);
        if (name == null) continue;
        // A constructor is not a symbol: what it does is done by its class.
        return tree instanceof MethodTree method && !method.getName().contentEquals("<init>") ? name + "." + method.getName() : name;
      }
      return "-";
    }

    Element elementOf(Tree child) {
      return trees.getElement(new TreePath(getCurrentPath(), child));
    }

    void call(Element target, Element owner, String member, String form, Tree at) {
      if (target == null || owner == null || owner.asType().getKind() == TypeKind.ERROR) {
        unresolved++;
        return;
      }
      String file = declaredIn(target);
      String name = className(owner);
      String shape = member == null ? "class" : "method";
      if (file == null) {
        // `values()` of an enum, an accessor of a record, a constructor nobody wrote: the class is ours, the member is nowhere.
        file = declaredIn(owner);
        if (file == null) {
          external++;
          return;
        }
        if (member != null) shape = "implicit member";
      }
      if (name == null) shape = "anonymous or local class";
      System.out.println(String.join("\t", "C", from, file, name == null ? "-" : member == null ? name : name + "." + member, shape, form, Long.toString(lineOf(at)), around()));
    }

    @Override
    public Void visitMethodInvocation(MethodInvocationTree node, Void unused) {
      Element target = trees.getElement(getCurrentPath());
      ExpressionTree select = node.getMethodSelect();
      String form = "name()";
      String written = select instanceof IdentifierTree identifier ? identifier.getName().toString() : "";
      if (select instanceof MemberSelectTree member) {
        ExpressionTree object = member.getExpression();
        Element receiver = object instanceof IdentifierTree || object instanceof MemberSelectTree ? elementOf2(member, object) : null;
        String text = object.toString();
        form = text.equals("this") ? "this.method()" : text.equals("super") ? "super.method()" : isClass(receiver) ? "Type.method()" : receiver == null ? "chained a.b().c()" : switch (receiver.getKind()) {
          case FIELD, ENUM_CONSTANT -> text.startsWith("this.") || !text.contains(".") ? "field.method()" : "chained a.b.c()";
          case LOCAL_VARIABLE, PARAMETER, EXCEPTION_PARAMETER, RESOURCE_VARIABLE, BINDING_VARIABLE -> "variable.method()";
          default -> "chained a.b().c()";
        };
      }
      if (!(target instanceof ExecutableElement method)) {
        unresolved++;
      } else if (written.equals("this") || written.equals("super")) {
        call(method, method.getEnclosingElement(), null, written + "(...) in a constructor", node);
      } else {
        call(method, method.getEnclosingElement(), method.getSimpleName().toString(), form, node);
      }
      return super.visitMethodInvocation(node, unused);
    }

    Element elementOf2(Tree parent, Tree child) {
      return trees.getElement(new TreePath(new TreePath(getCurrentPath(), parent), child));
    }

    @Override
    public Void visitNewClass(NewClassTree node, Void unused) {
      Element type = elementOf(node.getIdentifier());
      // An enum constant is written as a call of the enum's constructor, but nobody would call it one.
      Tree parent = getCurrentPath().getParentPath().getLeaf();
      boolean constant = parent instanceof VariableTree variable && trees.getElement(getCurrentPath().getParentPath()) != null && trees.getElement(getCurrentPath().getParentPath()).getKind() == ElementKind.ENUM_CONSTANT;
      if (constant) return super.visitNewClass(node, unused);
      if (isClass(type)) call(type, type, null, "new Type()", node);
      else unresolved++;
      return super.visitNewClass(node, unused);
    }

    void use(Element element) {
      if (!isClass(element)) return;
      String file = declaredIn(element);
      if (file != null && !file.equals(from)) System.out.println("I\t" + from + "\t" + file);
    }

    @Override
    public Void visitIdentifier(IdentifierTree node, Void unused) {
      use(trees.getElement(getCurrentPath()));
      return super.visitIdentifier(node, unused);
    }

    @Override
    public Void visitMemberSelect(MemberSelectTree node, Void unused) {
      use(trees.getElement(getCurrentPath()));
      return super.visitMemberSelect(node, unused);
    }
  }
}
