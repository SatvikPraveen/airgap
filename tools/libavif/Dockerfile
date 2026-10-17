# Reproducible single-threaded WebAssembly build of libavif + libaom for AVIF image sequences.
FROM emscripten/emsdk:6.0.11
RUN apt-get update && apt-get install -y --no-install-recommends git cmake ninja-build python3 perl && rm -rf /var/lib/apt/lists/*
ARG AOM_TAG=v3.15.2
ARG AVIF_TAG=v1.4.2
RUN git clone --depth 1 --branch ${AOM_TAG} https://aomedia.googlesource.com/aom /src/aom \
 && git clone --depth 1 --branch ${AVIF_TAG} https://github.com/AOMediaCodec/libavif.git /src/libavif
RUN emcmake cmake -S /src/aom -B /src/aom-build -G Ninja -DCMAKE_BUILD_TYPE=Release \
      -DAOM_TARGET_CPU=generic -DCONFIG_MULTITHREAD=0 -DCONFIG_RUNTIME_CPU_DETECT=0 \
      -DCONFIG_AV1_HIGHBITDEPTH=1 -DCONFIG_WEBM_IO=0 -DCONFIG_PIC=1 \
      -DENABLE_DOCS=0 -DENABLE_EXAMPLES=0 -DENABLE_TESTS=0 -DENABLE_TOOLS=0 -DENABLE_TESTDATA=0 \
      -DCMAKE_C_FLAGS="-O3" -DCMAKE_CXX_FLAGS="-O3" \
 && cmake --build /src/aom-build -j"$(nproc)"
RUN emcmake cmake -S /src/libavif -B /src/avif-build -G Ninja -DCMAKE_BUILD_TYPE=Release \
      -DBUILD_SHARED_LIBS=OFF -DAVIF_CODEC_AOM=SYSTEM -DAVIF_LIBYUV=OFF -DAVIF_LIBSHARPYUV=OFF \
      -DAVIF_LIBXML2=OFF -DAVIF_BUILD_APPS=OFF -DAVIF_BUILD_TESTS=OFF -DAVIF_ENABLE_WERROR=OFF \
      -DAOM_INCLUDE_DIR=/src/aom -DAOM_LIBRARY=/src/aom-build/libaom.a \
      -DCMAKE_C_FLAGS="-O3 -I/src/aom-build" \
 && cmake --build /src/avif-build -j"$(nproc)"
COPY airgap_avif.c /src/airgap_avif.c
RUN mkdir -p /out && emcc -O3 /src/airgap_avif.c -I/src/libavif/include \
      /src/avif-build/libavif.a /src/aom-build/libaom.a \
      -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createAirgapAvif -sENVIRONMENT=web,worker,node \
      -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=67108864 -sSTACK_SIZE=4194304 -sFILESYSTEM=0 -sDYNAMIC_EXECUTION=0 \
      -sINCOMING_MODULE_JS_API=instantiateWasm,wasmBinary \
      -sEXPORTED_FUNCTIONS=_malloc,_free,_aavif_free,_aavif_version,_aavif_decode_frames,_aavif_encode_frames \
      -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPU32,HEAPF64,UTF8ToString \
      -o /out/airgap_avif.js \
 && cd /out && sha256sum airgap_avif.js airgap_avif.wasm > SHA256SUMS
