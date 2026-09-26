package io.diffusion.ide.saf

import android.app.Activity
import android.content.Intent
import android.database.Cursor
import android.net.Uri
import android.provider.DocumentsContract
import android.util.Base64
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.ByteArrayOutputStream

@InvokeArg
class PathArgs {
  lateinit var treeUri: String
  var path: String = "."
}

@InvokeArg
class WriteArgs {
  lateinit var treeUri: String
  lateinit var path: String
  lateinit var data: String
}

@InvokeArg
class CreateArgs {
  lateinit var treeUri: String
  lateinit var path: String
  var kind: String = "file"
}

@InvokeArg
class MoveArgs {
  lateinit var treeUri: String
  lateinit var from: String
  lateinit var to: String
}

@TauriPlugin
class SafPlugin(private val activity: Activity) : Plugin(activity) {
  private val resolver get() = activity.contentResolver

  @Command
  fun pickTree(invoke: Invoke) {
    try {
      val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        addFlags(Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
        addFlags(Intent.FLAG_GRANT_PREFIX_URI_PERMISSION)
      }
      startActivityForResult(invoke, intent, "onPickTreeResult")
    } catch (ex: Exception) {
      invoke.reject(ex.message ?: "无法打开系统目录选择器")
    }
  }

  @ActivityCallback
  fun onPickTreeResult(invoke: Invoke, result: ActivityResult) {
    if (result.resultCode == Activity.RESULT_CANCELED) {
      invoke.reject("目录选择已取消")
      return
    }
    if (result.resultCode != Activity.RESULT_OK) {
      invoke.reject("系统目录选择失败")
      return
    }
    try {
      val uri = result.data?.data ?: throw IllegalStateException("系统没有返回目录 URI")
      val takeFlags = (result.data?.flags ?: 0) and
        (Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
      resolver.takePersistableUriPermission(uri, takeFlags)
      val root = rootDocument(uri)
      val out = JSObject()
      out.put("uri", uri.toString())
      out.put("name", queryName(root) ?: "project")
      out.put("readable", true)
      out.put("writable", true)
      invoke.resolve(out)
    } catch (ex: Exception) {
      invoke.reject(ex.message ?: "无法保存目录授权")
    }
  }

  @Command
  fun stat(invoke: Invoke) = command(invoke) {
    val args = invoke.parseArgs(PathArgs::class.java)
    val uri = resolveOrNull(Uri.parse(args.treeUri), cleanPath(args.path))
    if (uri == null) JSObject().apply { put("exists", false) } else statObject(uri)
  }

  @Command
  fun list(invoke: Invoke) = command(invoke) {
    val args = invoke.parseArgs(PathArgs::class.java)
    val tree = Uri.parse(args.treeUri)
    val path = cleanPath(args.path)
    val dir = resolve(tree, path)
    val flags = queryLong(dir, DocumentsContract.Document.COLUMN_FLAGS) ?: 0L
    val mime = queryString(dir, DocumentsContract.Document.COLUMN_MIME_TYPE)
    if (mime != DocumentsContract.Document.MIME_TYPE_DIR) throw IllegalArgumentException("$path 不是目录")
    val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(
      tree,
      DocumentsContract.getDocumentId(dir)
    )
    val arr = JSArray()
    resolver.query(
      childrenUri,
      arrayOf(
        DocumentsContract.Document.COLUMN_DOCUMENT_ID,
        DocumentsContract.Document.COLUMN_DISPLAY_NAME,
        DocumentsContract.Document.COLUMN_MIME_TYPE,
        DocumentsContract.Document.COLUMN_SIZE,
        DocumentsContract.Document.COLUMN_LAST_MODIFIED,
        DocumentsContract.Document.COLUMN_FLAGS,
      ), null, null, null
    )?.use { cursor ->
      while (cursor.moveToNext()) {
        val child = DocumentsContract.buildDocumentUriUsingTree(
          tree,
          cursor.getString(cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DOCUMENT_ID))
        )
        val name = cursor.getString(cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DISPLAY_NAME))
        val childMime = cursor.getString(cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_MIME_TYPE))
        val childPath = if (path == "." || path.isEmpty()) name else "$path/$name"
        val obj = JSObject()
        obj.put("name", name)
        obj.put("path", childPath)
        obj.put("type", if (childMime == DocumentsContract.Document.MIME_TYPE_DIR) "dir" else "file")
        obj.put("size", nullableLong(cursor, DocumentsContract.Document.COLUMN_SIZE))
        obj.put("mtime", nullableLong(cursor, DocumentsContract.Document.COLUMN_LAST_MODIFIED))
        obj.put("flags", nullableLong(cursor, DocumentsContract.Document.COLUMN_FLAGS) ?: flags)
        obj.put("uri", child.toString())
        arr.put(obj)
      }
    }
    val out = JSObject()
    out.put("entries", arr)
    out
  }

  @Command
  fun read(invoke: Invoke) = command(invoke) {
    val args = invoke.parseArgs(PathArgs::class.java)
    val path = cleanPath(args.path)
    val uri = resolve(Uri.parse(args.treeUri), path)
    val mime = queryString(uri, DocumentsContract.Document.COLUMN_MIME_TYPE)
    if (mime == DocumentsContract.Document.MIME_TYPE_DIR) throw IllegalArgumentException("$path 是目录")
    val bytes = resolver.openInputStream(uri)?.use { input ->
      val output = ByteArrayOutputStream()
      input.copyTo(output)
      output.toByteArray()
    } ?: throw IllegalStateException("无法读取 $path")
    val out = JSObject()
    out.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP))
    out.put("size", bytes.size)
    out.put("mtime", queryLong(uri, DocumentsContract.Document.COLUMN_LAST_MODIFIED))
    out
  }

  @Command
  fun write(invoke: Invoke) = command(invoke) {
    val args = invoke.parseArgs(WriteArgs::class.java)
    val tree = Uri.parse(args.treeUri)
    val path = cleanPath(args.path)
    if (path == ".") throw IllegalArgumentException("不能写入工作区根目录")
    val bytes = Base64.decode(args.data, Base64.DEFAULT)
    var target = resolveOrNull(tree, path)
    if (target == null) {
      val (parentPath, name) = splitParent(path)
      val parent = resolve(tree, parentPath)
      target = DocumentsContract.createDocument(resolver, parent, "application/octet-stream", name)
        ?: throw IllegalStateException("无法创建 $path")
    }
    val mode = if ((queryLong(target, DocumentsContract.Document.COLUMN_FLAGS) ?: 0L) and
      DocumentsContract.Document.FLAG_SUPPORTS_WRITE.toLong() != 0L) "rwt" else "w"
    resolver.openOutputStream(target, mode)?.use { output ->
      output.write(bytes)
      output.flush()
    } ?: throw IllegalStateException("无法写入 $path")
    statObject(target)
  }

  @Command
  fun create(invoke: Invoke) = command(invoke) {
    val args = invoke.parseArgs(CreateArgs::class.java)
    val tree = Uri.parse(args.treeUri)
    val path = cleanPath(args.path)
    if (path == ".") throw IllegalArgumentException("工作区根目录已经存在")
    if (resolveOrNull(tree, path) != null) throw IllegalStateException("$path 已经存在")
    val segments = path.split('/').filter { it.isNotEmpty() }
    var current = rootDocument(tree)
    for ((index, name) in segments.withIndex()) {
      val parentPath = segments.take(index).joinToString("/").ifEmpty { "." }
      val existing = findChild(tree, current, name)
      if (existing != null) {
        current = existing
        continue
      }
      val isLast = index == segments.lastIndex
      val mime = if (!isLast || args.kind == "dir") DocumentsContract.Document.MIME_TYPE_DIR else "application/octet-stream"
      current = DocumentsContract.createDocument(resolver, current, mime, name)
        ?: throw IllegalStateException("无法创建 ${if (parentPath == ".") name else "$parentPath/$name"}")
    }
    statObject(current)
  }

  @Command
  fun delete(invoke: Invoke) = command(invoke) {
    val args = invoke.parseArgs(PathArgs::class.java)
    val path = cleanPath(args.path)
    if (path == ".") throw IllegalArgumentException("不能删除工作区根目录")
    val uri = resolve(Uri.parse(args.treeUri), path)
    if (!DocumentsContract.deleteDocument(resolver, uri)) throw IllegalStateException("无法删除 $path")
    JSObject().apply { put("deleted", true) }
  }

  @Command
  fun rename(invoke: Invoke) = command(invoke) {
    val args = invoke.parseArgs(MoveArgs::class.java)
    val tree = Uri.parse(args.treeUri)
    val from = cleanPath(args.from)
    val to = cleanPath(args.to)
    if (from == "." || to == ".") throw IllegalArgumentException("不能移动工作区根目录")
    if (resolveOrNull(tree, to) != null) throw IllegalStateException("$to 已经存在")
    val source = resolve(tree, from)
    val (fromParentPath, _) = splitParent(from)
    val (toParentPath, toName) = splitParent(to)
    val fromParent = resolve(tree, fromParentPath)
    val toParent = resolve(tree, toParentPath)
    var moved = source
    if (fromParentPath != toParentPath) {
      moved = try {
        DocumentsContract.moveDocument(resolver, source, fromParent, toParent)
      } catch (_: Exception) { null } ?: run {
        copyRecursive(tree, source, toParent, toName)
        if (!DocumentsContract.deleteDocument(resolver, source)) throw IllegalStateException("复制后无法删除原文件")
        resolve(tree, to)
      }
    }
    if (queryName(moved) != toName) {
      moved = DocumentsContract.renameDocument(resolver, moved, toName)
        ?: throw IllegalStateException("无法重命名为 $toName")
    }
    statObject(moved)
  }

  @Command
  fun copy(invoke: Invoke) = command(invoke) {
    val args = invoke.parseArgs(MoveArgs::class.java)
    val tree = Uri.parse(args.treeUri)
    val from = cleanPath(args.from)
    val to = cleanPath(args.to)
    if (to == ".") throw IllegalArgumentException("不能覆盖工作区根目录")
    if (resolveOrNull(tree, to) != null) throw IllegalStateException("$to 已经存在")
    val source = resolve(tree, from)
    val (parentPath, name) = splitParent(to)
    val parent = resolve(tree, parentPath)
    val copied = copyRecursive(tree, source, parent, name)
    statObject(copied)
  }

  private fun command(invoke: Invoke, body: () -> JSObject) {
    try { invoke.resolve(body()) } catch (ex: Exception) { invoke.reject(ex.message ?: "SAF 操作失败") }
  }

  private fun cleanPath(raw: String): String {
    val normalized = raw.replace('\\', '/').trim('/').ifEmpty { "." }
    if (normalized == ".") return normalized
    val parts = normalized.split('/')
    if (parts.any { it.isEmpty() || it == "." || it == ".." }) throw IllegalArgumentException("路径无效")
    return parts.joinToString("/")
  }

  private fun splitParent(path: String): Pair<String, String> {
    val index = path.lastIndexOf('/')
    return if (index < 0) Pair(".", path) else Pair(path.substring(0, index), path.substring(index + 1))
  }

  private fun rootDocument(tree: Uri): Uri = DocumentsContract.buildDocumentUriUsingTree(
    tree, DocumentsContract.getTreeDocumentId(tree)
  )

  private fun resolve(tree: Uri, path: String): Uri = resolveOrNull(tree, path)
    ?: throw IllegalArgumentException("$path 不存在")

  private fun resolveOrNull(tree: Uri, path: String): Uri? {
    var current = rootDocument(tree)
    if (path == ".") return current
    for (segment in path.split('/')) {
      current = findChild(tree, current, segment) ?: return null
    }
    return current
  }

  private fun findChild(tree: Uri, parent: Uri, name: String): Uri? {
    val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, DocumentsContract.getDocumentId(parent))
    resolver.query(
      children,
      arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME),
      "${DocumentsContract.Document.COLUMN_DISPLAY_NAME}=?", arrayOf(name), null
    )?.use { cursor ->
      val idIndex = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DOCUMENT_ID)
      val nameIndex = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
      while (cursor.moveToNext()) {
        if (cursor.getString(nameIndex) == name) {
          return DocumentsContract.buildDocumentUriUsingTree(tree, cursor.getString(idIndex))
        }
      }
    }
    return null
  }

  private fun queryName(uri: Uri): String? = queryString(uri, DocumentsContract.Document.COLUMN_DISPLAY_NAME)

  private fun queryString(uri: Uri, column: String): String? = resolver.query(uri, arrayOf(column), null, null, null)?.use { cursor ->
    if (!cursor.moveToFirst()) null else cursor.getString(cursor.getColumnIndexOrThrow(column))
  }

  private fun queryLong(uri: Uri, column: String): Long? = resolver.query(uri, arrayOf(column), null, null, null)?.use { cursor ->
    if (!cursor.moveToFirst()) null else nullableLong(cursor, column)
  }

  private fun nullableLong(cursor: Cursor, column: String): Long? {
    val index = cursor.getColumnIndex(column)
    if (index < 0 || cursor.isNull(index)) return null
    return cursor.getLong(index)
  }

  private fun statObject(uri: Uri): JSObject {
    val out = JSObject()
    out.put("exists", true)
    resolver.query(
      uri,
      arrayOf(
        DocumentsContract.Document.COLUMN_DOCUMENT_ID,
        DocumentsContract.Document.COLUMN_DISPLAY_NAME,
        DocumentsContract.Document.COLUMN_MIME_TYPE,
        DocumentsContract.Document.COLUMN_SIZE,
        DocumentsContract.Document.COLUMN_LAST_MODIFIED,
        DocumentsContract.Document.COLUMN_FLAGS,
      ), null, null, null
    )?.use { cursor ->
      if (!cursor.moveToFirst()) throw IllegalStateException("文档不存在")
      val mime = cursor.getString(cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_MIME_TYPE))
      out.put("name", cursor.getString(cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DISPLAY_NAME)))
      out.put("type", if (mime == DocumentsContract.Document.MIME_TYPE_DIR) "dir" else "file")
      out.put("size", nullableLong(cursor, DocumentsContract.Document.COLUMN_SIZE))
      out.put("mtime", nullableLong(cursor, DocumentsContract.Document.COLUMN_LAST_MODIFIED))
      out.put("flags", nullableLong(cursor, DocumentsContract.Document.COLUMN_FLAGS))
      out.put("uri", uri.toString())
    } ?: throw IllegalStateException("无法读取文档信息")
    return out
  }

  private fun copyRecursive(tree: Uri, source: Uri, targetParent: Uri, targetName: String): Uri {
    val sourceMime = queryString(source, DocumentsContract.Document.COLUMN_MIME_TYPE)
      ?: throw IllegalStateException("无法读取源类型")
    if (sourceMime == DocumentsContract.Document.MIME_TYPE_DIR) {
      val dest = DocumentsContract.createDocument(resolver, targetParent, DocumentsContract.Document.MIME_TYPE_DIR, targetName)
        ?: throw IllegalStateException("无法创建目标目录")
      val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, DocumentsContract.getDocumentId(source))
      resolver.query(children, arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null)?.use { cursor ->
        val idIndex = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DOCUMENT_ID)
        val nameIndex = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
        while (cursor.moveToNext()) {
          val child = DocumentsContract.buildDocumentUriUsingTree(tree, cursor.getString(idIndex))
          copyRecursive(tree, child, dest, cursor.getString(nameIndex))
        }
      }
      return dest
    }
    val dest = DocumentsContract.createDocument(resolver, targetParent, sourceMime, targetName)
      ?: throw IllegalStateException("无法创建目标文件")
    resolver.openInputStream(source)?.use { input ->
      resolver.openOutputStream(dest, "w")?.use { output -> input.copyTo(output) }
        ?: throw IllegalStateException("无法打开目标文件")
    } ?: throw IllegalStateException("无法打开源文件")
    return dest
  }
}
