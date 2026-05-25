// Highcharts 초기화 — accessibility 모듈을 한 번 등록 (모듈 미포함 시 v11+ 가
// 브라우저 콘솔에 안내 경고를 띄움). chart 사용처는 "highcharts" 가 아니라 이
// 파일을 import 하면 모듈이 자동 부착된 Highcharts 객체를 얻는다.
//
// 정적: `import Highcharts from "@/lib/highcharts-init";`
// 동적: `(await import("@/lib/highcharts-init")).default`
import Highcharts from "highcharts";
import "highcharts/modules/accessibility";

export default Highcharts;
