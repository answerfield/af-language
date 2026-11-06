grammar AfLanguage

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

entry Document:
    elements+=TopLevelElement*;

TopLevelElement:
    Component | Item | Coding | Booklet | ElementDecl | FunctionDecl | EnumDecl;

type NamedElement =
    Component | Item | Booklet | ElementDecl | FunctionDecl | EnumDecl | EnumMember
    | Parameter | StateDecl | LetDecl | ForVariable | Binding | CodingRule;

type Callable = Component | ElementDecl | FunctionDecl;

// ---------------------------------------------------------------------------
// Components and items
// ---------------------------------------------------------------------------

Component:
    'component' name=Name
    '(' (parameters+=Parameter (',' parameters+=Parameter)*)? ')'
    (':' 'response' responseType=TypeReference)?
    (acceptsChildren?='children')?
    '{' body+=Statement* '}';

// Item parameters: numbers etc. from which versions are generated; their domains are declared in versions(when: …)
Item:
    'item' name=Name ('(' (parameters+=Parameter (',' parameters+=Parameter)*)? ')')? title=STRING? '{' body+=Statement* '}';

fragment TypeParameters:
    '<' typeParameters+=TypeParameter (',' typeParameters+=TypeParameter)* '>';

TypeParameter:
    name=Name;

// `state`: component state parameter that the caller can bind to its own state
Parameter:
    (variadic?='...' | isState?='state')? name=ParameterName ':' type=TypeReference ('=' defaultValue=Expression)?;

// Parameter names may coincide with keywords, e.g. tick(at: …, label: …) or Cloze(parts: …).
ParameterName returns string:
    Name | 'on' | 'in' | 'children' | 'item' | 'response' | 'booklet';

// Names: `builtin`, `element` and `events` act as keywords only in prelude declarations and are free names elsewhere.
Name returns string:
    ID | 'builtin' | 'element' | 'events';

TypeReference:
    name=Name ('<' arguments+=TypeReference (',' arguments+=TypeReference)* '>')? (optional?='?')?;

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

// Conditional display, versions, variants, parts and instructions are prelude elements, not syntax
// (show, versions, variant, part, instruction).
Statement:
    StateDecl | LetDecl | ForStatement | ResponseStatement | ChildrenStatement | Binding | ContentStatement;

// Inserts the caller's content (only in components declaring `children`)
ChildrenStatement:
    {infer ChildrenStatement} 'children';

StateDecl:
    'state' name=Name ':' type=TypeReference '=' initial=Expression;

LetDecl:
    'let' name=Name (':' type=TypeReference)? '=' value=Expression;

ForStatement:
    'for' variables+=ForVariable (',' variables+=ForVariable)? 'in' iterable=Expression
    '{' body+=Statement* '}';

ForVariable:
    name=Name;


ResponseStatement:
    'response' value=Expression;



// Named response, e.g. reduce = Gap(label: "…")
Binding:
    name=Name '=' value=Expression;

// Element with content (p { … }, p "…", toggle(…) { … }) or rendered content ("…", option)
ContentStatement:
    expression=Expression (hasBody?='{' body+=Statement* '}' | text=STRING)?;

// ---------------------------------------------------------------------------
// Booklets
// ---------------------------------------------------------------------------

// booklet b "Titel" { versions(when: …)  part("Teil 1", time: 20min) { instruction("…") { … }  aufgabe1 } }
Booklet:
    'booklet' name=Name title=STRING? '{' body+=Statement* '}';

// ---------------------------------------------------------------------------
// Coding
// ---------------------------------------------------------------------------

// Coding: one rule per line, a name and an expression:
//   reduce: correct(rational(reduce) == 3/4)                       right (code 1) / wrong (code 0)
//   reduce: codes(code(1, "richtig", score: 1, when: …), code(2, when: …))   custom codes
//   total:  sum_score(reduce, mark)                                  derived score
// If the name is not a response, the rule codes a subtask over the responses it uses.
Coding:
    'coding' item=[Item:Name] '{' rules+=CodingRule* '}';

CodingRule:
    name=Name ':' value=Expression;

// ---------------------------------------------------------------------------
// Built-in declarations (prelude only)
// ---------------------------------------------------------------------------

ElementDecl:
    'builtin' 'element' name=Name TypeParameters?
    '(' (parameters+=Parameter (',' parameters+=Parameter)*)? ')'
    (acceptsChildren?='children')?
    ('events' events+=EventDecl (',' events+=EventDecl)*)?;

EventDecl:
    name=Name;

// Function: built-in (signature only, in the prelude) or defined in AF as a single pure expression:
//   fn is_right_angle(a: Point?, vertex: Point?, b: Point?, tolerance: Rational = 1): Bool = …
FunctionDecl:
    (builtin?='builtin')? 'fn' name=Name TypeParameters?
    '(' (parameters+=Parameter (',' parameters+=Parameter)*)? ')'
    ':' returnType=TypeReference ('=' body=Expression)?;

EnumDecl:
    'enum' name=Name '{' members+=EnumMember (',' members+=EnumMember)* ','? '}';

EnumMember:
    name=Name;

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

Expression:
    IfExpression;

IfExpression infers Expression:
    {infer IfExpression} 'if' condition=Expression 'then' then=Expression 'else' else=Expression
    | OrExpression;

OrExpression infers Expression:
    AndExpression ({infer BinaryExpression.left=current} operator='or' right=AndExpression)*;

AndExpression infers Expression:
    NotExpression ({infer BinaryExpression.left=current} operator='and' right=NotExpression)*;

NotExpression infers Expression:
    {infer UnaryExpression} operator='not' operand=NotExpression
    | Comparison;

Comparison infers Expression:
    RangeExpression ({infer BinaryExpression.left=current}
        operator=('==' | '!=' | '<' | '<=' | '>' | '>=' | 'in') right=RangeExpression)?;

RangeExpression infers Expression:
    Additive ({infer RangeExpression.from=current} '..' to=Additive)?;

Additive infers Expression:
    Multiplicative ({infer BinaryExpression.left=current} operator=('+' | '-') right=Multiplicative)*;

Multiplicative infers Expression:
    Unary ({infer BinaryExpression.left=current} operator=('*' | '/') right=Unary)*;

Unary infers Expression:
    {infer UnaryExpression} operator='-' operand=Unary
    | Postfix;

// a.b (derived quantity), list[i] (element i, 1-based)
Postfix infers Expression:
    Primary ({infer MemberAccess.receiver=current} '.' member=Name | {infer IndexAccess.receiver=current} '[' index=Expression ']')*;

// (a + b) groups; (3 | 4) is a point in school notation
Primary infers Expression:
    '(' Expression ({infer PointLiteral.x=current} '|' y=Expression)? ')'
    | NumberLiteral
    | DimensionLiteral
    | StringLiteral
    | BooleanLiteral
    | NoneLiteral
    | SetLiteral
    | ListLiteral
    | Reference;

NumberLiteral:
    value=NumberValue;

DimensionLiteral:
    value=DIMENSION;

StringLiteral:
    value=STRING;

BooleanLiteral:
    value?='true' | 'false';

NoneLiteral:
    {infer NoneLiteral} 'none';

SetLiteral:
    {infer SetLiteral} '{' (elements+=Expression (',' elements+=Expression)*)? '}';

ListLiteral:
    {infer ListLiteral} '[' (elements+=Expression (',' elements+=Expression)*)? ']';

// Identifier or call: options, indexed(options, 1), toggle(role: radio)
Reference:
    target=[NamedElement:Name]
    (isCall?='(' (arguments+=Argument (',' arguments+=Argument)*)? ')')?;

Argument:
    Handler | ValueArgument;

ValueArgument:
    (parameter=[Parameter:ParameterName] ':')? value=Expression;

Handler:
    'on' event=[EventDecl:Name] ':' action=Assignment;

Assignment:
    target=[Writable:Name] ':=' value=Expression;

// Writable: state and state parameters
type Writable = StateDecl | Parameter;

NumberValue returns number:
    INT | DEC;

// ---------------------------------------------------------------------------
// Terminals
// ---------------------------------------------------------------------------

hidden terminal WS: /\s+/;
hidden terminal ML_COMMENT: /\/\*[\s\S]*?\*\//;
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;

terminal DIMENSION: /[0-9]+(\.[0-9]+)?(em|rem|px|ch|ms|min|s|%)(?![A-Za-z0-9_])/;
terminal DEC returns number: /[0-9]+\.[0-9]+/;
terminal INT returns number: /[0-9]+/;
terminal ID: /[_a-zA-Z][\w]*/;
terminal STRING: /"(\\.|[^"\\])*"/;
