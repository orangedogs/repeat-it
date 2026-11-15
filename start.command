#!/bin/bash
# macOS: 더블클릭하면 Repeat It가 브라우저에서 열립니다.
cd "$(dirname "$0")"
PORT=8765
(sleep 1; open "http://localhost:$PORT") &
echo "Repeat It 실행 중: http://localhost:$PORT  (끄려면 이 창을 닫으세요)"
python3 -m http.server $PORT
