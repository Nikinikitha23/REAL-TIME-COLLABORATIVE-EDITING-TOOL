class ShareDBCodeMirror {
  /**
   * @constructor
   * @param {CodeMirror} codeMirror - a CodeMirror editor instance
   * @param {Object} options - configuration options:
   *    - key: string; required. The key in the ShareDB doc at which to store the
   *      CodeMirror value. Deeply nested paths are currently not supported.
   *    - errorHandler: optional. A handler to which a single error message is
   *      provided. The default behavior is to print error messages to the console.
   *    - verbose: optional. If true, log messages will be printed to the console.
   * @return {ShareDBCodeMirror} the created ShareDBCodeMirror object
   */
  constructor(codeMirror, options) {
    this.codeMirror = codeMirror;
    this.key = options.key;
    this.errorHandler =
      options.errorHandler ||
      function (error) {
        console.error(error);
      };
    var verbose = Boolean(options.verbose);
    this.log = (...args) => {
      if (verbose) {
        console.debug.apply(console, args);
      }
    };

    this.suppressChange = false;
    this.codeMirrorBeforeChange = (...args) => {
      this.beforeLocalChange(...args);
    };
    this.codeMirrorChanges = (...args) => {
      this.afterLocalChanges(...args);
    };
    this.shareDBOp = (...args) => {
      this.onRemoteChange(...args);
    };
    this.shareDBDel = (...args) => {
      this.onDocDelete(...args);
    };
    this.shareDBError = (...args) => {
      this.onDocError(...args);
    };
  }

  /**
   * Attaches a ShareDB document to the CodeMirror instance.
   *
   * @param {sharedb.Doc} doc
   * @param {function (Object)=} callback - optional. Will be called when everything
   *    is hooked up. The first argument will be the error that occurred, if any.
   */
  attachDoc(doc, callback) {
    this.detachDoc();
    doc.subscribe(error => {
      if (error) {
        if (!callback) {
          console.error(error);
        }
      } else {
        this.doc = doc;
        this.log("ShareDBCodeMirror: subscribed to doc", doc);
        this.start();
      }
      if (callback) {
        callback(error);
      }
    });
  }

  /**
   * Starts listening for changes from the CodeMirror instance and the ShareDB
   * document. For CodeMirror, it is necessary to register for both
   * `beforeChange` and `changes` events: the first one is the only one to
   * report the positions in the pre-change coordinate system, while the latter
   * marks the end of the batch of operations.
   */
  start() {
    var doc = this.doc;
    var codeMirror = this.codeMirror;
    if (!doc.type) {
      this.log("ShareDBCodeMirror: creating emtpy doc");
      var data = {};
      data[this.key] = "";
      doc.create(data, error => {
        if (error) {
          this.errorHandler(error);
        }
      });
    }

    if (!doc.cm || doc.cm.version !== doc.version) {
      var cmDoc = new codeMirror.constructor.Doc(doc.data[this.key]);
      doc.cm = { doc: cmDoc };
    }
    codeMirror.swapDoc(doc.cm.doc);
    codeMirror.on("beforeChange", this.codeMirrorBeforeChange);
    codeMirror.on("changes", this.codeMirrorChanges);
    doc.on("op", this.shareDBOp);
    doc.on("del", this.shareDBDel);
    doc.on("error", this.shareDBError);
  }

  /**
   * Stops listening for changes from the CodeMirror instance and the ShareDB document.
   */
  detachDoc() {
    var doc = this.doc;
    if (!doc) {
      return;
    }
    doc.cm.version = doc.version;
    var codeMirror = this.codeMirror;
    codeMirror.off("beforeChange", this.codeMirrorBeforeChange);
    codeMirror.off("changes", this.codeMirrorChanges);
    doc.removeListener("op", this.shareDBOp);
    doc.removeListener("del", this.shareDBDel);
    doc.removeListener("error", this.shareDBError);
    delete this.doc;
    this.log("ShareDBCodeMirror: unsubscribed from doc");
  }

  /**
   * Asserts that the CodeMirror instance's value matches the document's content
   * in order to ensure that the two copies haven't diverged.
   */
  assertValue() {
    var expectedValue = this.doc.data[this.key];
    var editorValue = this.codeMirror.getValue();
    if (expectedValue !== editorValue) {
      console.error(
        "ShareDBCodeMirror: value in CodeMirror does not match expected value:",
        "\n\nExpected value:\n",
        expectedValue,
        "\n\nEditor value:\n",
        editorValue
      );

      this.suppressChange = true;
      this.codeMirror.setValue(expectedValue);
      this.suppressChange = false;
    }
  }

  /**
   * Applies the changes represented by the given array of OT operations. It
   * may be ignored if they are an echo of the most recently submitted local
   * operations.
   */
  onRemoteChange(ops, source) {
    if (source) {
      return;
    }

    this.log("ShareDBCodeMirror: applying ops", ops);
    this.suppressChange = true;
    for (var part of ops) {
      if (
        !(
          part.p &&
          part.p.length === 1 &&
          part.p[0] === this.key &&
          part.t === "text0"
        )
      ) {
        this.log(
          "ShareDBCodeMirror: ignoring op because of path or type:",
          part
        );
        continue;
      }

      var op = part.o;
      var codeMirror = this.codeMirror;
      if (op.length === 2 && op[0].d && op[1].i && op[0].p === op[1].p) {
        // replace operation
        var from = codeMirror.posFromIndex(op[0].p);
        var to = codeMirror.posFromIndex(op[0].p + op[0].d.length);
        codeMirror.replaceRange(op[1].i, from, to);
      } else {
        for (part of op) {
          var from = codeMirror.posFromIndex(part.p);
          if (part.d) {
            // delete operation
            var to = codeMirror.posFromIndex(part.p + part.d.length);
            codeMirror.replaceRange("", from, to);
          } else if (part.i) {
            // insert operation
            codeMirror.replaceRange(part.i, from);
          }
        }
      }
    }
    this.suppressChange = false;

    this.assertValue();
  }

  onDocDelete(data, source) {
    this.detachDoc();
    this.codeMirror.setValue("Document deleted");
  }

  onDocError(error) {
    this.errorHandler(error);
  }

  /**
   * Callback for the CodeMirror `beforeChange` event. It may be ignored if it
   * is an echo of the most recently applied remote operations, otherwise it
   * collects all the operations which are later sent to the server.
   */
  beforeLocalChange(codeMirror, change) {
    if (this.suppressChange) {
      return;
    }

    if (!this.ops) {
      this.ops = [];
    }
    var index = this.codeMirror.indexFromPos(change.from);
    if (change.from !== change.to) {
      // delete operation
      var deleted = codeMirror.getRange(change.from, change.to);
      this.ops.push({ p: index, d: deleted });
    }
    if (change.text[0] !== "" || change.text.length > 0) {
      // insert operation
      var inserted = change.text.join("\n");
      this.ops.push({ p: index, i: inserted });
    }
  }

  /**
   * Callback for the CodeMirror `changes` event. It may be ignored if it is
   * an echo of the most recently applied remote operations, otherwise it
   * sends the previously collected operations to the server.
   */
  afterLocalChanges(codeMirror, changes) {
    if (this.suppressChange) {
      return;
    }

    var op = [{ p: [this.key], t: "text0", o: this.ops }];
    delete this.ops;
    this.log("ShareDBCodeMirror: submitting op", op);
    this.doc.submitOp(op, error => {
      if (error) {
        this.errorHandler(error);
      }
    });

    this.assertValue();
  }
}
module.exports = ShareDBCodeMirror;
