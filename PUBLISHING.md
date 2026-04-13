# Публикация пакета и автопубликация через GitHub

В этом документе описано, как устроена публикация `@kmiyh/pi-skills-menu`, как настроить автопубликацию через GitHub Actions и как выпускать новые версии.

Сейчас репозиторий настроен на **двойную публикацию по тегу**:

- в **npm**
- в **GitHub Packages**

Это значит, что после пуша version tag пакет:

1. публикуется в npm
2. публикуется в GitHub Packages
3. появляется в разделе **Packages** на GitHub после успешной публикации в GitHub registry

---

## Как публикация работает сейчас

В репозитории есть workflow:

```text
.github/workflows/publish.yml
```

Он запускается, когда в репозиторий пушится git tag, соответствующий шаблону:

```text
v*
```

Примеры:

- `v1.0.1`
- `v1.1.0`
- `v2.0.0`

После пуша такого тега workflow делает следующее:

1. проверяет проект (`npm ci` + `npm run typecheck`)
2. публикует пакет в **npm**
3. публикует пакет в **GitHub Packages**

То есть один тег = одна автоматическая публикация сразу в два registry.

---

## Важное различие между npm и GitHub Packages

Это два разных registry.

### npm
Пакет публикуется в обычный npm registry и доступен на странице вида:

```text
https://www.npmjs.com/package/@kmiyh/pi-skills-menu
```

Это основной и самый удобный способ доставки пакета пользователям.

### GitHub Packages
Пакет дополнительно публикуется в GitHub registry:

```text
https://npm.pkg.github.com
```

Это нужно для того, чтобы:

- пакет отображался в разделе **Packages** на GitHub
- при желании его можно было устанавливать через GitHub Packages

Важно: публикация в npm **сама по себе** не создает GitHub Package. Поэтому для появления пакета в разделе **Packages** нужна отдельная публикация в GitHub Packages.

---

## Одноразовая настройка

Эти шаги нужно сделать один раз.

## 1. Проверь имя пакета

Пакет публикуется под именем:

```bash
@kmiyh/pi-skills-menu
```

Это важно, потому что:

- `@kmiyh` — это scope пакета
- для GitHub Packages scope должен совпадать с GitHub username / organization
- у тебя должны быть права на публикацию под этим scope

Проверь, что в `package.json` стоит:

```json
"name": "@kmiyh/pi-skills-menu"
```

---

## 2. Настрой публикацию в npm

Для публикации в npm workflow использует отдельный npm token.

### Как создать npm token

1. Открой [https://www.npmjs.com/](https://www.npmjs.com/)
2. Войди в аккаунт
3. Открой настройки аккаунта
4. Перейди в **Access Tokens**
5. Создай token для публикации

Лучше использовать token для automation/publishing.

После создания скопируй его значение.

### Как добавить token в GitHub

В репозитории на GitHub:

1. Открой **Settings**
2. Перейди в **Secrets and variables**
3. Открой **Actions**
4. Нажми **New repository secret**

Создай secret:

- **Name:** `NPM_TOKEN`
- **Value:** твой npm token

Без `NPM_TOKEN` job публикации в npm не сможет выполниться.

---

## 3. Настрой публикацию в GitHub Packages

Для GitHub Packages отдельный secret обычно не нужен.

Workflow использует встроенный GitHub token:

```yaml
${{ secrets.GITHUB_TOKEN }}
```

Для этого job в workflow уже выставлены нужные permissions:

```yaml
permissions:
  contents: read
  packages: write
```

То есть обычно ничего дополнительно настраивать не нужно, если публикация идет из GitHub Actions в том же репозитории.

---

## 4. Убедись, что workflow существует

В репозитории должен быть файл:

```text
.github/workflows/publish.yml
```

Сейчас он настроен так, что:

- `verify` job проверяет проект
- `publish-npm` публикует пакет в npm
- `publish-github-packages` публикует пакет в GitHub Packages

---

## Что настроено в `package.json`

Важные поля:

```json
{
  "name": "@kmiyh/pi-skills-menu",
  "publishConfig": {
    "access": "public"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/Kmiyh/pi-skills-menu.git"
  }
}
```

### Зачем нужен `publishConfig.access`

```json
"publishConfig": {
  "access": "public"
}
```

Это нужно для scoped package в npm, чтобы пакет публиковался как публичный.

### Почему здесь нет `publishConfig.registry`

Мы **специально не прописываем registry в `package.json`**.

Если указать:

```json
"publishConfig": {
  "registry": "https://npm.pkg.github.com"
}
```

то можно случайно сломать обычную публикацию в npm.

Вместо этого workflow сам переключает registry через `actions/setup-node` в каждом publish job отдельно:

- для npm используется `https://registry.npmjs.org`
- для GitHub Packages используется `https://npm.pkg.github.com`

Это самый безопасный вариант для двойной публикации.

---

## Рекомендуемые проверки перед первым релизом

Перед первым релизом рекомендуется локально из корня репозитория выполнить:

```bash
npm install
npm run typecheck
npm pack --dry-run
```

### Что делают эти команды

#### `npm install`
Устанавливает локальные зависимости для разработки.

#### `npm run typecheck`
Запускает TypeScript-проверку:

```bash
tsc --noEmit
```

#### `npm pack --dry-run`
Показывает, какие файлы попадут в npm-пакет, не публикуя его.

Это полезно, чтобы убедиться, что пакет содержит именно нужные файлы.

---

## Основной процесс релиза

После настройки новый релиз выпускается по очень простой схеме.

Общий порядок такой:

1. убедиться, что код в порядке
2. увеличить версию
3. запушить commit и tag
4. дождаться, пока GitHub Actions сам опубликует пакет в оба registry

---

## Что означают `npm version patch`, `minor`, `major`

Эти команды работают по semantic versioning:

```text
MAJOR.MINOR.PATCH
```

Пример:

```text
1.0.1
```

### `npm version patch`
Используй для небольших исправлений и безопасных улучшений.

Пример:

```text
1.0.1 -> 1.0.2
```

Когда использовать:

- bug fix
- исправление UI
- небольшой рефакторинг без изменения поведения
- правки README
- мелкие улучшения без ломающих изменений

Команда:

```bash
npm version patch
```

### `npm version minor`
Используй для новых возможностей без поломки обратной совместимости.

Пример:

```text
1.0.1 -> 1.1.0
```

Когда использовать:

- новая фича
- новый экран / новый сценарий в UI
- расширение поведения без поломки существующего использования

Команда:

```bash
npm version minor
```

### `npm version major`
Используй для ломающих изменений.

Пример:

```text
1.0.1 -> 2.0.0
```

Когда использовать:

- несовместимое изменение поведения
- удаление старых возможностей
- изменение конфигурации, требующее адаптации пользователей
- любые breaking changes

Команда:

```bash
npm version major
```

---

## Что делает `npm version`

Например:

```bash
npm version patch
```

Обычно эта команда автоматически делает следующее:

1. обновляет версию в `package.json`
2. обновляет версию в `package-lock.json`
3. создает git commit
4. создает git tag вида `v1.0.2`

Именно этот tag и запускает GitHub Actions workflow.

Поэтому после `npm version ...` очень важно выполнить:

```bash
git push --follow-tags
```

Если запушить только commit без tag, публикация не начнется.

---

## Точный порядок команд для релиза

### Patch release

Если это небольшое исправление:

```bash
npm run typecheck
npm pack --dry-run
npm version patch
git push --follow-tags
```

### Minor release

Если это новая фича без breaking changes:

```bash
npm run typecheck
npm pack --dry-run
npm version minor
git push --follow-tags
```

### Major release

Если это ломающий релиз:

```bash
npm run typecheck
npm pack --dry-run
npm version major
git push --follow-tags
```

---

## Что происходит после `git push --follow-tags`

После пуша commit и tag:

1. GitHub видит новый tag
2. запускается workflow `.github/workflows/publish.yml`
3. job `verify` делает `npm ci` и `npm run typecheck`
4. если проверка успешна, запускается job `publish-npm`
5. затем запускается job `publish-github-packages`
6. новая версия появляется в npm и в GitHub Packages

Следить за процессом можно во вкладке:

- **GitHub repository → Actions**

---

## Как проверить, что публикация в npm прошла успешно

### Через веб
Открой:

```text
https://www.npmjs.com/package/@kmiyh/pi-skills-menu
```

### Через CLI

```bash
npm view @kmiyh/pi-skills-menu versions
```

---

## Как проверить, что публикация в GitHub Packages прошла успешно

### На GitHub
Открой репозиторий и посмотри раздел:

- **Packages**

Там пакет должен появиться после первой успешной публикации в GitHub registry.

### Если пакет не появился сразу
Иногда GitHub может не показать его мгновенно. Также в отдельных случаях package может потребовать явной привязки к репозиторию в интерфейсе GitHub Packages.

Но если workflow `publish-github-packages` завершился успешно, значит публикация в registry состоялась.

---

## Как устанавливать пакет

### Основной рекомендуемый способ — из npm

```bash
pi install npm:@kmiyh/pi-skills-menu
```

Или через npm:

```bash
npm install @kmiyh/pi-skills-menu
```

### Установка из GitHub Packages

Если кто-то хочет устанавливать пакет именно из GitHub Packages, нужно настроить `.npmrc`.

Пример:

```ini
@kmiyh:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=GITHUB_TOKEN_OR_PAT
```

После этого можно выполнять:

```bash
npm install @kmiyh/pi-skills-menu
```

Но для обычных пользователей почти всегда удобнее установка из обычного npm registry.

---

## Почему используется публикация по тегу, а не по GitHub Release

Для этого репозитория выбран tag-based flow, потому что он лучше сочетается с `npm version`.

Нормальный сценарий такой:

```bash
npm version patch
git push --follow-tags
```

Это проще, чем:

1. обновлять версию
2. пушить код
3. вручную создавать GitHub Release
4. только потом запускать публикацию

Поэтому здесь логика такая:

- **tag** = технический релиз и триггер публикации
- **GitHub Release** = опциональное описание релиза для людей, если оно нужно

---

## Частые ошибки

### 1. Не добавлен `NPM_TOKEN`
Тогда публикация в npm завершится ошибкой.

### 2. Выполнен `git push`, но не запушен tag
Если сделать только:

```bash
git push
```

workflow не запустится.

Нужно делать:

```bash
git push --follow-tags
```

### 3. Выбран неправильный тип version bump
Используй:

- `patch` для исправлений
- `minor` для новых совместимых фич
- `major` для breaking changes

### 4. Публикация без typecheck
Перед релизом всегда желательно запускать:

```bash
npm run typecheck
```

### 5. Публикация неправильного набора файлов
Перед релизом полезно запускать:

```bash
npm pack --dry-run
```

### 6. Ожидание, что публикация в npm автоматически создаст GitHub Package
Это не так.

Чтобы пакет появился в разделе **Packages**, нужна отдельная публикация в GitHub Packages. Именно поэтому в workflow есть второй publish job.

---

## Рекомендуемый checklist перед каждым релизом

Перед релизом:

```bash
npm run typecheck
npm pack --dry-run
```

Потом выбрать тип релиза:

```bash
npm version patch
```

или:

```bash
npm version minor
```

или:

```bash
npm version major
```

После этого обязательно:

```bash
git push --follow-tags
```

---

## Минимальный повседневный release flow

### Для исправления

```bash
npm run typecheck
npm pack --dry-run
npm version patch
git push --follow-tags
```

### Для новой фичи

```bash
npm run typecheck
npm pack --dry-run
npm version minor
git push --follow-tags
```

### Для breaking release

```bash
npm run typecheck
npm pack --dry-run
npm version major
git push --follow-tags
```

Этого достаточно, чтобы GitHub Actions автоматически опубликовал пакет и в npm, и в GitHub Packages.
