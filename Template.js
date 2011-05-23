var toString = Object.prototype.toString
  , slice = Array.prototype.slice
  ;

function isFunction(o) {
  return (toString.call(o) === "[object Function]");
}

function inheritFrom(child, parent) {
  function F() {};
  F.prototype = parent.prototype;
  child.prototype = new F();
  child.prototype.constructor = child;
}

function lookup(a) {
  var obj = {}
    , l = a.length
    ;
  for (var i = 0; i < l; i++) {
    obj[a[i]] = true;
  }
  return obj;
}

function escapeString(s) {
  return s.replace('\\', '\\\\').replace('"', '\\"');
}

/** Separator used for object lookups. */
var VAR_LOOKUP_SEPARATOR = '.';
/** Separator for specifying multiple variable names to be unpacked. */
var UNPACK_SEPARATOR_RE = /, ?/;
/** RegExp for template variables. */
var VARIABLE_RE = /{{(.*?)}}/;
/** RegExp for trimming whitespace. */
var TRIM_RE = /^\s+|\s+$/g;

/**
 * Thrown when pop() is called too many times on a Context.
 */
function ContextPopError() {
  this.message = 'pop() was called more times than push()';
}
inheritFrom(ContextPopError, Error);

/**
 * Thrown when a Variable cannot be resolved.
 */
function VariableNotFoundError(message) {
  this.message = message;
}
inheritFrom(VariableNotFoundError, Error);

/**
 * Thrown when expressions cannot be parsed.
 */
function TemplateSyntaxError(message) {
  this.message = message;
}
inheritFrom(TemplateSyntaxError, Error);

/**
 * Resolves variables based on a context, supporting object property lookups
 * specified with '.' separators.
/**
 * Resolves variable expressions based on a context, supporting object property
 * lookups specified with '.' separators.
 */
function Variable(expr) {
  this.expr = expr;
}

Variable.prototype.resolve = function(context) {
  // First lookup is in the context
  var bits = this.expr.split(VAR_LOOKUP_SEPARATOR)
    , bit = bits.shift()
    , current = context.get(bit)
    ;
  if (!context.hasKey(bit)) {
    throw new VariableNotFoundError('Could not find [' + bit + '] in ' + context);
  } else if (isFunction(current)) {
    current = current();
  }

  // Any further lookups are against current object properties
  if (bits.length) {
    var l = bits.length
      , next
      ;
    for (var i = 0; i < l; i++) {
      bit = bits[i];
      if (current === null ||
          current === undefined ||
          typeof current[bit] == 'undefined') {
        throw new VariableNotFoundError('Could not find [' + bit + '] in ' + current);
      }
      next = current[bit];
      // Call functions with the current object as context
      if (isFunction(next)) {
        current = next.call(current);
      } else {
        current = next;
      }
    }
  }

  return current;
}

/**
 * Manages a stack of objects holding template context variables.
 */
function Context(initial) {
  if (!(this instanceof Context)) return new Context(initial);
  this.stack = [initial || {}];
}

Context.prototype.push = function(context) {
  this.stack.push(context || {});
};

Context.prototype.pop = function() {
  if (this.stack.length == 1) {
    throw new ContextPopError();
  }
  return this.stack.pop();
};

Context.prototype.set = function(name, value) {
  this.stack[this.stack.length - 1][name] = value;
};

/**
 * Adds multiple items to the current context object, where names and values are
 * provided as lists.
 */
Context.prototype.zip = function(names, values) {
  var top = this.stack[this.stack.length - 1]
    , l = Math.min(names.length, values.length)
    ;
  for (var i = 0; i < l; i++) {
    top[names[i]] = values[i];
  }
};

/**
 * Gets variables, checking all context objects from top to bottom.
 *
 * Returns undefined for variables which are not set, to distinguish from
 * variables which are set, but are null.
 */
Context.prototype.get = function(name, d) {
  for (var i = this.stack.length - 1; i >= 0; i--) {
    if (this.stack[i].hasOwnProperty(name)) {
      return this.stack[i][name];
    }
  }
  return d !== undefined ? d : null;
};

/**
 * Determine if a particular key is set in the context.
 */
Context.prototype.hasKey = function(name) {
  for (var i = 0, l = this.stack.length; i < l; i++) {
    if (this.stack[i].hasOwnProperty(name)) {
      return true;
    }
  }
  return false;
};

/**
 * Convenience method for calling render() on a list of content items
 * with this context.
 */
Context.prototype.render = function(contents) {
  var results = [];
  for (var i = 0, l = contents.length; i < l; i++) {
    results.push(contents[i].render(this));
  }
  return results;
};

/**
 * Supports looping over a list obtained from the context, creating new
 * context variables with list contents and calling render on all its
 * contents.
 */
function ForNode(props, contents) {
  for (var prop in props) {
    this.loopVars = prop.split(UNPACK_SEPARATOR_RE);
    this.listVar = new Variable(props[prop]);
    break;
  }
  this.contents = contents;
}

ForNode.prototype.render = function(context) {
  var list = this.listVar.resolve(context)
    , l = list.length
    , item
    , results = []
    , forloop = {
        counter: 1
      , counter0: 0
      , revcounter: l
      , revcounter0: l - 1
      , first: true
      , last: l === 1
      , parentloop: context.get('forloop')
      }
    ;
  context.push();
  context.set('forloop', forloop);
  for (var i = 0; i < l; i++) {
    item = list[i];
    // Set current item(s) in context variable(s)
    if (this.loopVars.length === 1) {
      context.set(this.loopVars[0], item);
    } else {
      context.zip(this.loopVars, item);
    }
    // Update loop status variables
    if (i > 0) {
      forloop.counter++;
      forloop.counter0++;
      forloop.revcounter--;
      forloop.revcounter0--;
      forloop.first = false;
      forloop.last = (i === l - 1);
    }
    // Render contents
    for (var j = 0, k = this.contents.length; j < k; j++) {
      results.push(this.contents[j].render(context));
    }
  }
  context.pop();
  return results;
};

/**
 * Marker for the end of a ForNode, where its contents are specified as
 * siblings to reduce the amount of nesting required.
 */
function EndForNode() { }

/**
 * Executes a boolean test using variables obtained from the context,
 * calling render on all its if the result is true.
 */
function IfNode(expr, contents) {
  if (isFunction(expr)) {
    this.test = expr;
  } else {
    this.test = this.parse(expr);
  }
  this.contents = contents;
}

IfNode.prototype.parse = (function() {
  var ops = lookup('( ) && || == === <= < >= > != !== !! !'.split(' '))
    , opsRE = /(\(|\)|&&|\|\||={2,3}|<=|<|>=|>|!={1,2}|!{1,2})/
    , numberRE = /^-?(?:\d+(?:\.\d+)?|(?:\d+)?\.\d+)$/
    , quotes = lookup(['"', "'"])
    , isQuotedString = function(s) {
        var q = s.charAt(0);
        return (s.length > 1 &&
                typeof quotes[q] != 'undefined' &&
                s.lastIndexOf(q) == s.length - 1);
      }
    ;
  return function(expr) {
    var code = ['return (']
      , bits = expr.split(opsRE)
      , l = bits.length
      , bit
      ;
    for (var i = 0; i < l; i++) {
      bit = bits[i];
      if (typeof ops[bit] != 'undefined') {
        code.push(bit);
      } else {
        bit = bit.replace(TRIM_RE, '');
        if (bit) {
          if (numberRE.test(bit) || isQuotedString(bit)) {
            code.push(bit);
          } else {
            code.push('new Variable("' + escapeString(bit) + '").resolve(c)');
          }
        }
      }
    }
    code.push(');');
    try {
      return new Function('c', code.join(' '));
    } catch (e) {
      throw new TemplateSyntaxError('Invalid $if expression (' + e.message +
                                    '): ' + expr);
    }
  }
})();

IfNode.prototype.render = function(context) {
  if (this.test(context)) {
    return context.render(this.contents);
  }
  return [];
}

/**
 * Marker for the end of an IfNode, where its contents are specified as
 * siblings to reduce the amount of nesting required.
 */
function EndIfNode() { }

function TextNode(text) {
  this.dynamic = VARIABLE_RE.test(text);
  if (this.dynamic) {
    this.func = this._parseExpr(text);
  } else {
    this.text = text;
  }
}

/**
 * Creates a function which accepts context and performs replacement by
 * variable resolution on the given expression.
 */
TextNode.prototype._parseExpr = function(expr) {
  var code = ['var a = []']
    , bits = expr.split(VARIABLE_RE)
    , l = bits.length
    ;
  for (var i = 0; i < l; i++) {
    if (i % 2) {
      code.push('a.push(new Variable("' +
                escapeString(bits[i].replace(TRIM_RE, '')) +
                '").resolve(c))');
    } else {
      code.push('a.push("' + escapeString(bits[i]) + '")');
    }
  }
  code.push('return a.join("")');
  return new Function('c', code.join(';'));
}

TextNode.prototype.render = function(context) {
  return (this.dynamic ? this.func(context) : this.text);
};

/** Convenience method for creating a Variable in a template definition. */
function $var(variable) {
  return new Variable(variable);
}

/** Convenience method for creating a ForNode in a template definition. */
function $for(props) {
  return new ForNode(props, slice.call(arguments, 1));
}

/** Convenience method for creating an EndForNode in a template definition. */
function $endfor() {
  return new EndForNode();
}
/** Convenience method for creating an IfNode in a template definition. */
function $if(props) {
  return new IfNode(props, slice.call(arguments, 1));
}

/** Convenience method for creating an EndIfNode in a template definition. */
function $endif() {
  return new EndIfNode();
}

// WIP -----------------------------------------------------------------------

function Template(props, contents) {
  this.name = props.name;
  this.extends_ = props['extends'];
  this.contents = contents; // TODO Check for dynamic content
}

function Block(name, contents) {
  this.name = name;
  this.contents = contents;
}

// These need to hook into the DOMBuilder API via the introduction of a new
// mode, to be used when instantiating Template objects.
function TemplateElement(tagName, attributes, contents) {
    this.tagName = tagName;
    this.attributes = attributes;
    this.contents = contents;
}

function TemplateFragment(children) {
    this.contents = contents;
}

function TemplateHTMLNode(html) {
   this.html = html;
}

// Template convenience functions
function $template(props) {
  return new Template(props, slice.call(arguments, 1));
}

function $block(name) {
  return new Block(name, slice.call(arguments, 1));
}

function $html(contents) {
  return new RawHTMLNode(contents);
}

// Helper functions
function checkDynamicContents(contents) {
  var content
    , l = l = contents.length
    ;
  for (var i = 0; i < l; i++) {
    content = contents[i];

  }
}
function processMarkerNodes(item) {
  // Find these
  // $for/$if, element, element, $endfor/$endif
  // And end up with this
  // $for/$if[contents=[element, element]
}