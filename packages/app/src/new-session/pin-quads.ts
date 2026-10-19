// Draws a pin board layer as a list of filled parallelograms. With WebGL2 the whole list is at most two
// instanced draws, so a frame costs about the same however many pins there are. A 2D canvas spends a
// GPU draw call on most shapes, which kept weak machines busy. Without WebGL2 each quad is a transformed
// 2D rect, which looks the same but costs a canvas call per quad.

export type Rgba = readonly [number, number, number, number]
export type Quads = ReturnType<typeof createQuads>

type Region = { x: number; y: number; w: number; h: number }

const FLOATS = 10
const BLACK: Rgba = [0, 0, 0, 1]

const VERTEX = `#version 300 es
in vec2 corner;
in vec2 origin;
in vec2 u;
in vec2 v;
in vec4 color;
uniform vec2 view;
uniform vec2 size;
uniform float scale;
out vec2 st;
out vec2 span;
out vec4 tint;
void main() {
  vec2 du = u * scale;
  vec2 dv = v * scale;
  float area = max(abs(du.x * dv.y - du.y * dv.x), 1e-4);
  // span is the quad's width across each pair of edges in device pixels; the quad grows a pixel
  // past every edge so partly covered pixels get drawn.
  span = vec2(area / max(length(dv), 1e-4), area / max(length(du), 1e-4));
  st = mix(-1.0 / span, 1.0 + 1.0 / span, corner);
  vec2 p = (origin - view) * scale + du * st.x + dv * st.y;
  gl_Position = vec4(p.x / size.x * 2.0 - 1.0, 1.0 - p.y / size.y * 2.0, 0.0, 1.0);
  tint = color;
}`

// Coverage is the overlap of the pixel with the quad along each axis, which is exact for axis-aligned rects.
const FRAGMENT = `#version 300 es
precision highp float;
in vec2 st;
in vec2 span;
in vec4 tint;
out vec4 outColor;
void main() {
  vec2 d = st * span;
  vec2 c = clamp(min(d + 0.5, span) - max(d - 0.5, 0.0), 0.0, 1.0);
  outColor = tint * (c.x * c.y);
}`

export function createQuads(canvas: HTMLCanvasElement, restored: () => void) {
  // Each quad's colour is also kept as given, for the 2D fallback.
  const data = { list: new Float32Array(FLOATS * 1024), tints: [] as Rgba[], count: 0, shadows: 0 }
  // The context is created on first draw, so a layer that never shows pins never holds one.
  const surface: {
    current?: { gl: WebGL2RenderingContext; gpu: ReturnType<typeof setup> } | { ctx: CanvasRenderingContext2D }
  } = {}
  const styles = new WeakMap<Rgba, string>()

  const push = (x: number, y: number, ux: number, uy: number, vx: number, vy: number, c: Rgba) => {
    if ((data.count + 1) * FLOATS > data.list.length) {
      const grown = new Float32Array(data.list.length * 2)
      grown.set(data.list)
      data.list = grown
    }
    const list = data.list
    data.tints[data.count] = c
    const i = data.count++ * FLOATS
    const a = c[3]
    list[i] = x
    list[i + 1] = y
    list[i + 2] = ux
    list[i + 3] = uy
    list[i + 4] = vx
    list[i + 5] = vy
    list[i + 6] = (c[0] / 255) * a
    list[i + 7] = (c[1] / 255) * a
    list[i + 8] = (c[2] / 255) * a
    list[i + 9] = a
  }

  return {
    begin() {
      data.count = 0
      data.shadows = 0
    },
    /** Black shadows, all of one alpha, go first and merge where they overlap instead of darkening. */
    shadow(x: number, y: number, w: number, h: number, alpha: number) {
      push(x, y, w, 0, 0, h, BLACK)
      data.list[data.count * FLOATS - 1] = alpha
      data.shadows = data.count
    },
    rect(x: number, y: number, w: number, h: number, c: Rgba) {
      push(x, y, w, 0, 0, h, c)
    },
    /** The parallelogram with a corner at (x, y) and edges u and v. */
    quad(x: number, y: number, ux: number, uy: number, vx: number, vy: number, c: Rgba) {
      push(x, y, ux, uy, vx, vy, c)
    },
    draw(region: Region, scale: number) {
      surface.current ??= open()
      if ("gl" in surface.current) return drawGL(surface.current.gl, surface.current.gpu, region, scale)
      drawCanvas(surface.current.ctx, region, scale)
    },
    dispose() {
      if (surface.current && "gl" in surface.current)
        surface.current.gl.getExtension("WEBGL_lose_context")?.loseContext()
    },
  }

  function open() {
    const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, antialias: false })
    if (gl) return { gl, gpu: setup(gl) }
    return { ctx: canvas.getContext("2d")! }
  }

  function drawGL(gl: WebGL2RenderingContext, gpu: ReturnType<typeof setup>, region: Region, scale: number) {
    if (gl.isContextLost()) return
    if (!gpu.ready) gpu.init()
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    if (!data.count) return
    gl.useProgram(gpu.program)
    gl.bindVertexArray(gpu.vao)
    gl.uniform2f(gpu.view, region.x, region.y)
    gl.uniform2f(gpu.size, canvas.width, canvas.height)
    gl.uniform1f(gpu.scale, scale)
    gl.bindBuffer(gl.ARRAY_BUFFER, gpu.instances)
    // The GPU buffer is reused across frames and only reallocated when the quad list outgrows it.
    if (gpu.capacity < data.list.length) {
      gpu.capacity = data.list.length
      gl.bufferData(gl.ARRAY_BUFFER, gpu.capacity * 4, gl.DYNAMIC_DRAW)
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data.list, 0, data.count * FLOATS)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    if (data.shadows) {
      gl.blendEquation(gl.MAX)
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, data.shadows)
    }
    gl.blendEquation(gl.FUNC_ADD)
    if (data.count > data.shadows) {
      gpu.offset(data.shadows)
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, data.count - data.shadows)
      gpu.offset(0)
    }
  }

  function drawCanvas(ctx: CanvasRenderingContext2D, region: Region, scale: number) {
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    const at = (x: number, y: number, ux: number, uy: number, vx: number, vy: number) =>
      ctx.setTransform(scale * ux, scale * uy, scale * vx, scale * vy, scale * (x - region.x), scale * (y - region.y))
    const list = data.list
    // Shadows go down opaque and are faded together, so overlaps stay one shade.
    ctx.fillStyle = "#000"
    for (let n = 0; n < data.shadows; n++) {
      const i = n * FLOATS
      at(list[i], list[i + 1], list[i + 2], list[i + 3], list[i + 4], list[i + 5])
      ctx.fillRect(0, 0, 1, 1)
    }
    if (data.shadows) {
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.globalCompositeOperation = "destination-in"
      ctx.globalAlpha = list[9]
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.globalCompositeOperation = "source-over"
      ctx.globalAlpha = 1
    }
    for (let n = data.shadows; n < data.count; n++) {
      const i = n * FLOATS
      const c = data.tints[n]
      ctx.fillStyle = styles.get(c) ?? styles.set(c, `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${c[3]})`).get(c)!
      at(list[i], list[i + 1], list[i + 2], list[i + 3], list[i + 4], list[i + 5])
      ctx.fillRect(0, 0, 1, 1)
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0)
  }

  // GPU objects are rebuilt after the context is lost and restored.
  function setup(gl: WebGL2RenderingContext) {
    const gpu = {
      ready: false,
      capacity: 0,
      program: null as WebGLProgram | null,
      vao: null as WebGLVertexArrayObject | null,
      instances: null as WebGLBuffer | null,
      view: null as WebGLUniformLocation | null,
      size: null as WebGLUniformLocation | null,
      scale: null as WebGLUniformLocation | null,
      attributes: [] as { at: number; size: number; offset: number }[],
      init() {
        const program = gl.createProgram()!
        for (const [type, source] of [
          [gl.VERTEX_SHADER, VERTEX],
          [gl.FRAGMENT_SHADER, FRAGMENT],
        ] as const) {
          const shader = gl.createShader(type)!
          gl.shaderSource(shader, source)
          gl.compileShader(shader)
          gl.attachShader(program, shader)
        }
        gl.linkProgram(program)
        gpu.program = program
        gpu.view = gl.getUniformLocation(program, "view")
        gpu.size = gl.getUniformLocation(program, "size")
        gpu.scale = gl.getUniformLocation(program, "scale")
        gpu.vao = gl.createVertexArray()
        gl.bindVertexArray(gpu.vao)
        const corners = gl.createBuffer()
        gl.bindBuffer(gl.ARRAY_BUFFER, corners)
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW)
        const corner = gl.getAttribLocation(program, "corner")
        gl.enableVertexAttribArray(corner)
        gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0)
        gpu.instances = gl.createBuffer()
        gpu.capacity = 0
        gl.bindBuffer(gl.ARRAY_BUFFER, gpu.instances)
        gpu.attributes = [
          { at: gl.getAttribLocation(program, "origin"), size: 2, offset: 0 },
          { at: gl.getAttribLocation(program, "u"), size: 2, offset: 2 },
          { at: gl.getAttribLocation(program, "v"), size: 2, offset: 4 },
          { at: gl.getAttribLocation(program, "color"), size: 4, offset: 6 },
        ]
        for (const a of gpu.attributes) {
          gl.enableVertexAttribArray(a.at)
          gl.vertexAttribDivisor(a.at, 1)
        }
        gpu.offset(0)
        gpu.ready = true
      },
      // Points the per-quad attributes at the given first quad, so one buffer serves both draws.
      offset(first: number) {
        for (const a of gpu.attributes)
          gl.vertexAttribPointer(a.at, a.size, gl.FLOAT, false, FLOATS * 4, (first * FLOATS + a.offset) * 4)
      },
    }
    canvas.addEventListener("webglcontextlost", (event) => event.preventDefault())
    canvas.addEventListener("webglcontextrestored", () => {
      gpu.ready = false
      restored()
    })
    return gpu
  }
}
