# Twitter memo
## version 0.0.3
# 용어
1.  id : Twitter User Identifier
1.  name : Twitter User handle
1.  popup : 
#  기능
1.  트위터 유저 프로필 페이지에서 저장된 메모를 볼 수 있음
2.  트위터 유저 프로필 페이지에서, 확장프로그램을 클릭해서 나온 팝업 창을 통해 메모를 추가할 수 있음

## 구현
1.  background
    *   chrome.storage.local에 id: memo 쌍을 저장
1.  popup
    *   popup에서 현재 페이지의 사용자의 id를 content를 통해 얻어 와 name을 얻을 수 있음
    *   popup에서 background를 통해 현재 페이지의 사용자에게 메모를 남길 수 있음
        *   내용은 background를 통해 저장
    *   popup에서 저장된 메모의 리스트를 확인할 수 있음
1.  content
    *   현재 페이지에서 css selector를 이용해 id를 얻음
    *   현재 페이지에 필요한 memo가 존재할 경우 페이지를 수정해서 프로필에 memo를 표시


##    추가 예정
1.  popup에서 메모 삭제하기 
    *   삭제 버튼을 추가하자
1.  popup에서 메모 수정하기 
    *   메모 셀을 클릭하여 넘어가게 하는 게 어떨까?
1.  popup에서 프로필 방문하기
    *   ID 셀을 클릭하여 프로필을 방문하게 하자
1.  플러그인에서 자동으로 페이지를 새로고침 하기


###     버그
1.  리스트에서 클릭해도 넘어가지 않는 문제
1.  https://twitter.com/intent/user?screen_name= 형태의 주소에서 유저 정보를 불러오지 못하는 버그
    *   하드코딩으로 고칠지 고민이 필요
        *정규식 처리로 해결할 수 있을까?


###     버그/해결됨
1.  undefined 뜨는거 고치기 
1.  /home 방문 다음 프로필 페이지 방문 시 메모 미표시 오류
    *   head > script:nth-child(50) 오류 해결하기 
1.  popup에서 메모 리스트 확인하기
1.  트위터가 아닌 사이트나, 트위터인데 처리하지 않은 페이지에서 popup 시 오류가 발생하는 버그
    *   개발자 도구에서 오류 로그가 찍힘
    *   리스트가 표시되지 않음(오류가 찍혀서 그 뒤가 씹힌건지? 이유를 모르겠음)
