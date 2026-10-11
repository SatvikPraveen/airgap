# Reproducible single-threaded WebAssembly build of libjxl for Airgap.
# Everything is pinned: the emsdk image (by tag; record its digest in BUILD.md) and the libjxl tag.
FROM emscripten/emsdk:5.0.7
RUN apt-get update && apt-get install -y --no-install-recommends git cmake ninja-build python3 && rm -rf /var/lib/apt/lists/*
ARG LIBJXL_TAG=v0.12.0
RUN git clone --depth 1 --branch ${LIBJXL_TAG} --recurse-submodules --shallow-submodules https://github.com/libjxl/libjxl.git /src/libjxl
WORKDIR /src/libjxl
RUN emcmake cmake -S . -B build -G Ninja \
      -DCMAKE_BUILD_TYPE=Release \
      -DBUILD_SHARED_LIBS=OFF -DBUILD_TESTING=OFF \
      -DJPEGXL_STATIC=ON -DJPEGXL_ENABLE_TOOLS=OFF -DJPEGXL_ENABLE_DEVTOOLS=OFF \
      -DJPEGXL_ENABLE_BENCHMARK=OFF -DJPEGXL_ENABLE_EXAMPLES=OFF -DJPEGXL_ENABLE_MANPAGES=OFF \
      -DJPEGXL_ENABLE_DOXYGEN=OFF -DJPEGXL_ENABLE_JNI=OFF -DJPEGXL_ENABLE_SJPEG=OFF \
      -DJPEGXL_ENABLE_OPENEXR=OFF -DJPEGXL_ENABLE_JPEGLI=OFF -DJPEGXL_ENABLE_PLUGINS=OFF \
      -DJPEGXL_ENABLE_VIEWERS=OFF -DJPEGXL_ENABLE_SKCMS=ON -DJPEGXL_BUNDLE_LIBPNG=OFF \
      -DJPEGXL_ENABLE_TRANSCODE_JPEG=ON -DJPEGXL_ENABLE_BOXES=ON -DJPEGXL_ENABLE_AVX512=OFF \
      -DJPEGXL_FORCE_SYSTEM_BROTLI=OFF -DJPEGXL_FORCE_SYSTEM_HWY=OFF \
      -DCMAKE_C_FLAGS="-O3" -DCMAKE_CXX_FLAGS="-O3" \
 && cmake --build build --target jxl jxl_cms jxl_threads -j"$(nproc)" || cmake --build build --target jxl jxl_cms -j"$(nproc)"
COPY airgap_jxl.cc /src/airgap_jxl.cc
RUN mkdir -p /out && em++ -O3 -std=c++17 /src/airgap_jxl.cc \
      -I/src/libjxl/lib/include -I/src/libjxl/build/lib/include \
      $(find /src/libjxl/build -name 'libjxl.a' -o -name 'libjxl_cms.a' -o -name 'libhwy.a' -o -name 'libbrotlienc.a' -o -name 'libbrotlidec.a' -o -name 'libbrotlicommon.a' -o -name 'libskcms*.a' | sort) \
      -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createAirgapJxl -sENVIRONMENT=web,worker,node \
      -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=33554432 -sSTACK_SIZE=2097152 -sFILESYSTEM=0 -sDYNAMIC_EXECUTION=0 \
      -sINCOMING_MODULE_JS_API=instantiateWasm,wasmBinary \
      -sEXPORTED_FUNCTIONS=_malloc,_free,_ajxl_free,_ajxl_version,_ajxl_encode,_ajxl_decode,_ajxl_jpeg_to_jxl,_ajxl_jxl_to_jpeg \
      -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPU32,HEAPF32 \
      -o /out/airgap_jxl.js \
 && cd /out && sha256sum airgap_jxl.js airgap_jxl.wasm > SHA256SUMS
