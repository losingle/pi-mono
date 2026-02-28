import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOutlineTool } from "../src/core/tools/outline.js";

function getTextOutput(result: any): string {
	return (
		result.content
			?.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n") || ""
	);
}

describe("outline tool", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `outline-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	// ======================================================================
	// TypeScript
	// ======================================================================
	describe("TypeScript", () => {
		it("应提取 class、function、interface、type、enum", async () => {
			const file = join(testDir, "sample.ts");
			writeFileSync(
				file,
				`
export interface Foo {
	bar: string;
}

export type Id = string | number;

export enum Color {
	Red,
	Green,
}

export class MyClass {
	method() {}
}

export function hello(name: string) {
	return name;
}

export const greet = (name: string) => name;
`.trimStart(),
			);

			const tool = createOutlineTool(testDir);
			const result = await tool.execute("t1", { path: file });
			const output = getTextOutput(result);

			expect(output).toContain("interface Foo");
			expect(output).toContain("type Id =");
			expect(output).toContain("enum Color");
			expect(output).toContain("class MyClass");
			expect(output).toContain("function hello");
			expect(output).toContain("greet");
			expect(result.details?.definitionCount).toBeGreaterThanOrEqual(6);
		});

		it("应包含行号", async () => {
			const file = join(testDir, "lines.ts");
			writeFileSync(
				file,
				`interface A {}
function b() {}
`,
			);

			const tool = createOutlineTool(testDir);
			const result = await tool.execute("t2", { path: file });
			const output = getTextOutput(result);

			expect(output).toContain("L1:");
			expect(output).toContain("L2:");
		});

		it("应跳过注释行", async () => {
			const file = join(testDir, "comments.ts");
			writeFileSync(
				file,
				`// function skipped() {}
function kept() {}
`,
			);

			const tool = createOutlineTool(testDir);
			const result = await tool.execute("t3", { path: file });
			const output = getTextOutput(result);

			expect(output).not.toContain("skipped");
			expect(output).toContain("kept");
		});

		it("应处理 declare 和 namespace", async () => {
			const file = join(testDir, "declare.ts");
			writeFileSync(
				file,
				`declare namespace MyNS {
	export interface Inner {}
}
`,
			);

			const tool = createOutlineTool(testDir);
			const result = await tool.execute("t4", { path: file });
			const output = getTextOutput(result);

			expect(output).toContain("namespace MyNS");
			expect(output).toContain("interface Inner");
		});
	});

	// ======================================================================
	// JavaScript
	// ======================================================================
	describe("JavaScript", () => {
		it("应提取 class、function、arrow function", async () => {
			const file = join(testDir, "sample.js");
			writeFileSync(
				file,
				`
class Widget {}
function render() {}
const handler = (e) => e;
const old = function legacy() {};
`.trimStart(),
			);

			const tool = createOutlineTool(testDir);
			const result = await tool.execute("t5", { path: file });
			const output = getTextOutput(result);

			expect(output).toContain("class Widget");
			expect(output).toContain("function render");
			expect(output).toContain("handler");
			expect(output).toContain("old");
		});
	});

	// ======================================================================
	// Python
	// ======================================================================
	describe("Python", () => {
		it("应提取 class 和 def", async () => {
			const file = join(testDir, "sample.py");
			writeFileSync(
				file,
				`
class MyClass:
    def method(self):
        pass

def standalone():
    pass

async def async_func():
    pass
`.trimStart(),
			);

			const tool = createOutlineTool(testDir);
			const result = await tool.execute("t6", { path: file });
			const output = getTextOutput(result);

			expect(output).toContain("class MyClass");
			expect(output).toContain("def method");
			expect(output).toContain("def standalone");
			expect(output).toContain("async def async_func");
		});
	});

	// ======================================================================
	// Go
	// ======================================================================
	describe("Go", () => {
		it("应提取 func、type struct、type interface", async () => {
			const file = join(testDir, "sample.go");
			writeFileSync(
				file,
				`package main

type Server struct {
	port int
}

type Handler interface {
	Handle()
}

func (s *Server) Start() {}

func main() {}
`,
			);

			const tool = createOutlineTool(testDir);
			const result = await tool.execute("t7", { path: file });
			const output = getTextOutput(result);

			expect(output).toContain("type Server struct");
			expect(output).toContain("type Handler interface");
			expect(output).toContain("func (s *Server) Start");
			expect(output).toContain("func main");
		});
	});

	// ======================================================================
	// Rust
	// ======================================================================
	describe("Rust", () => {
		it("应提取 fn、struct、enum、trait、impl", async () => {
			const file = join(testDir, "sample.rs");
			writeFileSync(
				file,
				`
pub struct Config {
    name: String,
}

pub enum Status {
    Active,
    Inactive,
}

pub trait Runnable {
    fn run(&self);
}

impl Runnable for Config {
    fn run(&self) {}
}

pub async fn start() {}
`.trimStart(),
			);

			const tool = createOutlineTool(testDir);
			const result = await tool.execute("t8", { path: file });
			const output = getTextOutput(result);

			expect(output).toContain("struct Config");
			expect(output).toContain("enum Status");
			expect(output).toContain("trait Runnable");
			expect(output).toContain("impl Runnable for Config");
			expect(output).toContain("fn run");
			expect(output).toContain("async fn start");
		});
	});

	// ======================================================================
	// C/C++
	// ======================================================================
	describe("C/C++", () => {
		it("应提取 function、struct、enum、class、macro", async () => {
			const file = join(testDir, "sample.h");
			writeFileSync(
				file,
				`
#define MAX_SIZE 1024

struct Point {
    int x, y;
};

enum Direction {
    UP, DOWN
};

class Widget {
public:
    void render();
};

int main(int argc, char** argv) {
    return 0;
}
`.trimStart(),
			);

			const tool = createOutlineTool(testDir);
			const result = await tool.execute("t9", { path: file });
			const output = getTextOutput(result);

			expect(output).toContain("MAX_SIZE");
			expect(output).toContain("struct Point");
			expect(output).toContain("enum Direction");
			expect(output).toContain("class Widget");
			expect(output).toContain("int main");
		});
	});

	// ======================================================================
	// Ruby
	// ======================================================================
	describe("Ruby", () => {
		it("应提取 class、module、def", async () => {
			const file = join(testDir, "sample.rb");
			writeFileSync(
				file,
				`
module MyModule
  class MyClass
    def my_method
    end
  end
end
`.trimStart(),
			);

			const tool = createOutlineTool(testDir);
			const result = await tool.execute("t10", { path: file });
			const output = getTextOutput(result);

			expect(output).toContain("module MyModule");
			expect(output).toContain("class MyClass");
			expect(output).toContain("def my_method");
		});
	});

	// ======================================================================
	// Shell
	// ======================================================================
	describe("Shell", () => {
		it("应提取 function 定义", async () => {
			const file = join(testDir, "sample.sh");
			writeFileSync(
				file,
				`#!/bin/bash

setup() {
  echo "setting up"
}

function cleanup() {
  echo "cleaning"
}
`,
			);

			const tool = createOutlineTool(testDir);
			const result = await tool.execute("t11", { path: file });
			const output = getTextOutput(result);

			expect(output).toContain("setup()");
			expect(output).toContain("cleanup()");
		});
	});

	// ======================================================================
	// 边界情况
	// ======================================================================
	describe("边界情况", () => {
		it("空文件应返回 no definitions", async () => {
			const file = join(testDir, "empty.ts");
			writeFileSync(file, "");

			const tool = createOutlineTool(testDir);
			const result = await tool.execute("t12", { path: file });
			const output = getTextOutput(result);

			expect(output).toContain("No definitions found");
			expect(result.details).toBeUndefined();
		});

		it("不存在的文件应抛错", async () => {
			const tool = createOutlineTool(testDir);
			await expect(tool.execute("t13", { path: join(testDir, "nope.ts") })).rejects.toThrow(/Cannot read file/);
		});

		it("纯注释文件应返回 no definitions", async () => {
			const file = join(testDir, "comments-only.ts");
			writeFileSync(
				file,
				`// This is a comment
// Another comment
// function notReal() {}
`,
			);

			const tool = createOutlineTool(testDir);
			const result = await tool.execute("t14", { path: file });
			const output = getTextOutput(result);

			expect(output).toContain("No definitions found");
		});

		it("未知文件扩展名应使用 fallback 模式", async () => {
			const file = join(testDir, "unknown.xyz");
			writeFileSync(
				file,
				`function doSomething() {
}

class MyClass {
}
`,
			);

			const tool = createOutlineTool(testDir);
			const result = await tool.execute("t15", { path: file });
			const output = getTextOutput(result);

			expect(output).toContain("doSomething");
			expect(output).toContain("MyClass");
		});

		it("超长行应被截断", async () => {
			const file = join(testDir, "long.ts");
			const longName = "a".repeat(200);
			writeFileSync(file, `function ${longName}() {}\n`);

			const tool = createOutlineTool(testDir);
			const result = await tool.execute("t16", { path: file });
			const output = getTextOutput(result);

			expect(output).toContain("...");
			expect(output.length).toBeLessThan(300);
		});

		it("应正确报告总行数和定义数", async () => {
			const file = join(testDir, "count.ts");
			writeFileSync(
				file,
				`function a() {}
function b() {}
function c() {}
const x = 1;
const y = 2;
`,
			);

			const tool = createOutlineTool(testDir);
			const result = await tool.execute("t17", { path: file });
			const output = getTextOutput(result);

			// 文件末尾 \n 会产生额外空行，split("\n") 结果为 6
			expect(output).toContain("6 lines");
			expect(output).toContain("3 definitions");
			expect(result.details?.definitionCount).toBe(3);
		});

		it("嵌套定义应保留缩进层级", async () => {
			const file = join(testDir, "nested.ts");
			writeFileSync(
				file,
				`export class Outer {
	export const inner = () => {};
}
`,
			);

			const tool = createOutlineTool(testDir);
			const result = await tool.execute("t18", { path: file });
			const output = getTextOutput(result);

			// class Outer 无缩进，inner 有缩进
			const lines = output.split("\n").filter((l) => l.includes("L"));
			const outerLine = lines.find((l) => l.includes("Outer"));
			const innerLine = lines.find((l) => l.includes("inner"));
			expect(outerLine).toBeDefined();
			expect(innerLine).toBeDefined();
			// inner 应该有缩进前缀空格
			if (outerLine && innerLine) {
				const outerIndent = outerLine.length - outerLine.trimStart().length;
				const innerIndent = innerLine.length - innerLine.trimStart().length;
				expect(innerIndent).toBeGreaterThan(outerIndent);
			}
		});
	});

	// ======================================================================
	// Java
	// ======================================================================
	describe("Java", () => {
		it("应提取 class、interface、enum、method", async () => {
			const file = join(testDir, "Sample.java");
			writeFileSync(
				file,
				`
public class Sample {
    public void doWork() {
    }

    private static int compute(int x) {
        return x;
    }
}

public interface Doable {
    void doIt();
}

public enum Severity {
    LOW, HIGH
}
`.trimStart(),
			);

			const tool = createOutlineTool(testDir);
			const result = await tool.execute("t19", { path: file });
			const output = getTextOutput(result);

			expect(output).toContain("class Sample");
			expect(output).toContain("doWork");
			expect(output).toContain("compute");
			expect(output).toContain("interface Doable");
			expect(output).toContain("enum Severity");
		});
	});

	// ======================================================================
	// AST 专项测试（TS/JS 特有能力）
	// ======================================================================
	describe("AST 专项", () => {
		it("多行函数签名应完整提取", async () => {
			const file = join(testDir, "multiline.ts");
			writeFileSync(
				file,
				`export function createWidget(
  name: string,
  options: { color: string; size: number },
  callback: () => void
): Widget {
  return {} as Widget;
}
`,
			);

			const tool = createOutlineTool(testDir);
			const result = await tool.execute("ast1", { path: file });
			const output = getTextOutput(result);

			// AST 应提取完整签名，包括参数
			expect(output).toContain("createWidget");
			expect(output).toContain("name: string");
			expect(output).toContain("callback");
		});

		it("泛型类型参数应正确展示", async () => {
			const file = join(testDir, "generics.ts");
			writeFileSync(
				file,
				`export function map<T, U>(arr: T[], fn: (item: T) => U): U[] {
  return arr.map(fn);
}

export interface Repository<T extends Entity> {
  findById(id: string): T;
}

export class Cache<K, V> {
  get(key: K): V | undefined { return undefined; }
}
`,
			);

			const tool = createOutlineTool(testDir);
			const result = await tool.execute("ast2", { path: file });
			const output = getTextOutput(result);

			expect(output).toContain("<T, U>");
			expect(output).toContain("<T extends Entity>");
			expect(output).toContain("<K, V>");
		});

		it("类继承和接口实现应完整展示", async () => {
			const file = join(testDir, "heritage.ts");
			writeFileSync(
				file,
				`export class Dog extends Animal implements Serializable {
  bark() {}
}

export interface ReadableStream extends EventEmitter {
  read(): Buffer;
}
`,
			);

			const tool = createOutlineTool(testDir);
			const result = await tool.execute("ast3", { path: file });
			const output = getTextOutput(result);

			expect(output).toContain("extends Animal");
			expect(output).toContain("implements Serializable");
			expect(output).toContain("extends EventEmitter");
		});

		it("getter / setter 应被正确识别", async () => {
			const file = join(testDir, "accessor.ts");
			writeFileSync(
				file,
				`export class Config {
  private _value = 0;
  get value(): number { return this._value; }
  set value(v: number) { this._value = v; }
}
`,
			);

			const tool = createOutlineTool(testDir);
			const result = await tool.execute("ast4", { path: file });
			const output = getTextOutput(result);

			expect(output).toContain("[getter]");
			expect(output).toContain("get value");
			expect(output).toContain("[setter]");
			expect(output).toContain("set value");
		});

		it("字符串中的 function/class 关键字不应误匹配", async () => {
			const file = join(testDir, "false-positive.ts");
			writeFileSync(
				file,
				`const message = "function hello() { class Foo }";
const lines = \`
  function fake() {}
  class NotReal {}
\`;

export function realFunction() {}
`,
			);

			const tool = createOutlineTool(testDir);
			const result = await tool.execute("ast5", { path: file });
			const output = getTextOutput(result);

			// AST 只应提取真正的函数声明
			expect(output).toContain("realFunction");
			// 字符串中的 fake / NotReal 不应出现
			expect(output).not.toContain("fake");
			expect(output).not.toContain("NotReal");
		});

		it("enum 成员应被内联展示", async () => {
			const file = join(testDir, "enum.ts");
			writeFileSync(
				file,
				`export enum Direction {
  North,
  South,
  East,
  West,
}
`,
			);

			const tool = createOutlineTool(testDir);
			const result = await tool.execute("ast6", { path: file });
			const output = getTextOutput(result);

			expect(output).toContain("enum Direction");
			expect(output).toContain("North");
			expect(output).toContain("South");
		});

		it("namespace 嵌套应正确显示层级", async () => {
			const file = join(testDir, "namespace.ts");
			writeFileSync(
				file,
				`export namespace API {
  export function getUser(id: string): User { return {} as User; }
  export interface User {
    name: string;
  }
}
`,
			);

			const tool = createOutlineTool(testDir);
			const result = await tool.execute("ast7", { path: file });
			const output = getTextOutput(result);

			// namespace 应在顶层
			expect(output).toContain("[namespace]");
			expect(output).toContain("API");
			// 内部成员应有缩进
			const lines = output.split("\n").filter((l) => l.includes("L"));
			const nsLine = lines.find((l) => l.includes("API"));
			const fnLine = lines.find((l) => l.includes("getUser"));
			expect(nsLine).toBeDefined();
			expect(fnLine).toBeDefined();
			if (nsLine && fnLine) {
				const nsIndent = nsLine.length - nsLine.trimStart().length;
				const fnIndent = fnLine.length - fnLine.trimStart().length;
				expect(fnIndent).toBeGreaterThan(nsIndent);
			}
		});

		it("构造函数应被提取", async () => {
			const file = join(testDir, "constructor.ts");
			writeFileSync(
				file,
				`export class Service {
  constructor(private readonly db: Database, public name: string) {}
  start() {}
}
`,
			);

			const tool = createOutlineTool(testDir);
			const result = await tool.execute("ast8", { path: file });
			const output = getTextOutput(result);

			expect(output).toContain("[constructor]");
			expect(output).toContain("constructor(");
			expect(output).toContain("db: Database");
			expect(output).toContain("[method]");
			expect(output).toContain("start()");
		});

		it("返回值类型应被展示", async () => {
			const file = join(testDir, "return-type.ts");
			writeFileSync(
				file,
				`export function parse(input: string): { ok: boolean; data: unknown } {
  return { ok: true, data: null };
}

export async function fetchData(url: string): Promise<Response> {
  return fetch(url);
}
`,
			);

			const tool = createOutlineTool(testDir);
			const result = await tool.execute("ast9", { path: file });
			const output = getTextOutput(result);

			expect(output).toContain(": { ok: boolean; data: unknown }");
			expect(output).toContain(": Promise<Response>");
			expect(output).toContain("async");
		});

		it("export default 应被记录", async () => {
			const file = join(testDir, "default-export.ts");
			writeFileSync(
				file,
				`const config = { a: 1 };
export default config;
`,
			);

			const tool = createOutlineTool(testDir);
			const result = await tool.execute("ast10", { path: file });
			const output = getTextOutput(result);

			expect(output).toContain("export default");
		});

		it("JSX 文件应正常解析", async () => {
			const file = join(testDir, "component.tsx");
			writeFileSync(
				file,
				`import React from "react";

interface Props {
  name: string;
}

export function Greeting({ name }: Props): JSX.Element {
  return <div>Hello {name}</div>;
}

export const App: React.FC = () => {
  return <Greeting name="world" />;
};
`,
			);

			const tool = createOutlineTool(testDir);
			const result = await tool.execute("ast11", { path: file });
			const output = getTextOutput(result);

			expect(output).toContain("interface Props");
			expect(output).toContain("Greeting");
			expect(output).toContain("App");
		});

		it("抽象类和方法应正确标记", async () => {
			const file = join(testDir, "abstract.ts");
			writeFileSync(
				file,
				`export abstract class Shape {
  abstract area(): number;
  perimeter(): number { return 0; }
}
`,
			);

			const tool = createOutlineTool(testDir);
			const result = await tool.execute("ast12", { path: file });
			const output = getTextOutput(result);

			expect(output).toContain("abstract class Shape");
			expect(output).toContain("abstract area()");
			expect(output).toContain("perimeter()");
		});

		it("接口方法签名应被提取", async () => {
			const file = join(testDir, "interface-methods.ts");
			writeFileSync(
				file,
				`export interface Logger {
  log(message: string): void;
  warn(message: string, code?: number): void;
}
`,
			);

			const tool = createOutlineTool(testDir);
			const result = await tool.execute("ast13", { path: file });
			const output = getTextOutput(result);

			expect(output).toContain("interface Logger");
			expect(output).toContain("log(");
			expect(output).toContain("warn(");
		});
	});

	// ======================================================================
	// abort signal
	// ======================================================================
	describe("abort signal", () => {
		it("已取消的 signal 应立即抛错", async () => {
			const file = join(testDir, "abort.ts");
			writeFileSync(file, "function f() {}");

			const tool = createOutlineTool(testDir);
			const controller = new AbortController();
			controller.abort();

			await expect(tool.execute("t20", { path: file }, controller.signal)).rejects.toThrow(/aborted/i);
		});
	});
});
