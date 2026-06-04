---
description: 새 엔티티에 대한 CRUD 보일러플레이트를 생성합니다.
---

워크스페이스의 기술 스택을 자동 감지한 후, 사용자가 지정한 엔티티에 대한 CRUD 코드를 생성합니다.

먼저 사용자에게 물어보세요:
- **엔티티 이름** (예: User, Product, Order)
- **필드 목록** (이름, 타입, 필수 여부)
- **퍼시스턴스 종류** (이미 사용 중인 ORM/DB 자동 감지 후 확인)
- **인증 필요 여부**

감지할 스택:
- **백엔드**: Express/Fastify/NestJS/Spring Boot/Django/FastAPI
- **DB**: Prisma/TypeORM/Mongoose/Sequelize/SQLAlchemy/JPA
- **프론트**: React/Next.js/Vue — 폼/리스트/상세 페이지

생성 결과:
1. 모델/스키마 정의
2. Repository / DAO (있다면)
3. Service / 비즈니스 로직
4. Controller / Router
5. (선택) 프론트 페이지/컴포넌트
6. 단위 테스트
7. (있다면) 마이그레이션 파일

규칙:
- 기존 프로젝트의 컨벤션 (네이밍, 폴더 구조, 에러 처리) 그대로 따름
- 한국어 주석 추가 (한국어 모드일 때)
- 생성된 파일 목록과 다음 단계(마이그레이션 실행 등)를 한국어로 안내
- 큰 작업이므로 `/계획` 도 함께 생성 권장
