/* Ridgewood v0.5.3 — ownership-aware /showchunks rendering. */
(() => {
  'use strict';

  const canvas = document.querySelector('#canvas');
  if (!canvas || window.__RIDGEWOOD_CLAIM_BORDER_PATCH__) return;
  window.__RIDGEWOOD_CLAIM_BORDER_PATCH__ = true;

  const originalGetContext = canvas.getContext.bind(canvas);

  canvas.getContext = function patchedGetContext(type, attributes) {
    const gl = originalGetContext(type, attributes);
    if (type === 'webgl2' && gl && !gl.__ridgewoodClaimBorders) install(gl);
    return gl;
  };

  function install(gl) {
    gl.__ridgewoodClaimBorders = true;

    const native = {
      bindBuffer: gl.bindBuffer.bind(gl),
      bindVertexArray: gl.bindVertexArray.bind(gl),
      bufferData: gl.bufferData.bind(gl),
      drawArrays: gl.drawArrays.bind(gl),
      getUniformLocation: gl.getUniformLocation.bind(gl),
      uniform3f: gl.uniform3f.bind(gl),
      uniform4f: gl.uniform4f.bind(gl),
      useProgram: gl.useProgram.bind(gl),
      vertexAttribPointer: gl.vertexAttribPointer.bind(gl)
    };

    let currentArrayBuffer = null;
    let currentVao = null;
    let currentProgram = null;
    const vaoBuffers = new WeakMap();
    const bufferSnapshots = new WeakMap();
    const programUniforms = new WeakMap();

    gl.bindBuffer = function bindBuffer(target, buffer) {
      if (target === gl.ARRAY_BUFFER) currentArrayBuffer = buffer;
      return native.bindBuffer(target, buffer);
    };

    gl.bindVertexArray = function bindVertexArray(vao) {
      currentVao = vao;
      return native.bindVertexArray(vao);
    };

    gl.vertexAttribPointer = function vertexAttribPointer(index, size, type, normalized, stride, offset) {
      if (index === 0 && currentVao && currentArrayBuffer) {
        vaoBuffers.set(currentVao, currentArrayBuffer);
      }
      return native.vertexAttribPointer(index, size, type, normalized, stride, offset);
    };

    gl.bufferData = function bufferData(target, data, usage, srcOffset, length) {
      if (target === gl.ARRAY_BUFFER && currentArrayBuffer && ArrayBuffer.isView(data)) {
        const start = Number(srcOffset) || 0;
        const available = data.length - start;
        const count = Number.isFinite(Number(length)) ? Math.min(Number(length), available) : available;
        const slice = data.subarray(start, start + count);
        if (slice instanceof Float32Array) {
          bufferSnapshots.set(currentArrayBuffer, new Float32Array(slice));
        }
      }
      return arguments.length > 3
        ? native.bufferData(target, data, usage, srcOffset, length)
        : native.bufferData(target, data, usage);
    };

    gl.useProgram = function useProgram(program) {
      currentProgram = program;
      return native.useProgram(program);
    };

    function uniformsFor(program) {
      let uniforms = programUniforms.get(program);
      if (!uniforms) {
        uniforms = {
          color: native.getUniformLocation(program, 'uColor'),
          offset: native.getUniformLocation(program, 'uOffset')
        };
        programUniforms.set(program, uniforms);
      }
      return uniforms;
    }

    function worldState() {
      try {
        return window.VOXEL_GAME_API?.getWorldState?.() || null;
      } catch {
        return null;
      }
    }

    function ownershipFor(state, chunkX, chunkZ) {
      const record = state?.chunks?.get?.(`${chunkX},${chunkZ}`);
      if (!record?.ownerId) return 'unclaimed';
      return record.ownerId === state.userId ? 'mine' : 'other';
    }

    const styles = {
      unclaimed: {
        color: [1.0, 0.76, 0.16, 0.30],
        offsets: [[0, 0, 0]]
      },
      other: {
        color: [1.0, 0.06, 0.10, 0.98],
        offsets: [
          [0, 0.018, 0], [0.038, 0.018, 0], [-0.038, 0.018, 0],
          [0, 0.018, 0.038], [0, 0.018, -0.038],
          [0.027, 0.018, 0.027], [-0.027, 0.018, -0.027]
        ]
      },
      mine: {
        color: [0.04, 0.46, 1.0, 1.0],
        offsets: [
          [0, 0.024, 0], [0.048, 0.024, 0], [-0.048, 0.024, 0],
          [0, 0.024, 0.048], [0, 0.024, -0.048],
          [0.034, 0.024, 0.034], [0.034, 0.024, -0.034],
          [-0.034, 0.024, 0.034], [-0.034, 0.024, -0.034]
        ]
      }
    };

    gl.drawArrays = function drawArrays(mode, first, count) {
      const buffer = currentVao && vaoBuffers.get(currentVao);
      const vertices = buffer && bufferSnapshots.get(buffer);
      const uniforms = currentProgram && uniformsFor(currentProgram);

      // The /showchunks buffer contains 128 vertices per 16x16 chunk:
      // four edges, sixteen line segments per edge, two vertices per segment.
      const isChunkBorderPass = mode === gl.LINES
        && count >= 128
        && count % 128 === 0
        && vertices?.length >= (first + count) * 3
        && uniforms?.color
        && uniforms?.offset;

      if (!isChunkBorderPass) return native.drawArrays(mode, first, count);

      const state = worldState();
      const groups = { unclaimed: [], other: [], mine: [] };
      const chunks = count / 128;

      for (let index = 0; index < chunks; index += 1) {
        const vertex = first + index * 128;
        const dataIndex = vertex * 3;
        const chunkX = Math.round(vertices[dataIndex] / 16);
        const chunkZ = Math.round(vertices[dataIndex + 2] / 16);
        const ownership = ownershipFor(state, chunkX, chunkZ);
        groups[ownership].push(vertex);
      }

      // Draw subtle unclaimed borders first, then red claims, then the
      // player's blue claims last so their outline is brightest and thickest.
      for (const ownership of ['unclaimed', 'other', 'mine']) {
        const style = styles[ownership];
        native.uniform4f(uniforms.color, ...style.color);
        for (const vertex of groups[ownership]) {
          for (const offset of style.offsets) {
            native.uniform3f(uniforms.offset, ...offset);
            native.drawArrays(gl.LINES, vertex, 128);
          }
        }
      }

      native.uniform3f(uniforms.offset, 0, 0, 0);
      return undefined;
    };
  }
})();
