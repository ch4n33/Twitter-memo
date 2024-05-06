const idPosition = 'head > script:nth-child(49)';
const memoPosition = '#react-root > div > div > div.css-175oi2r.r-1f2l425.r-13qz1uu.r-417010.r-18u37iz > main > div > div > div > div > div > div:nth-child(3) > div > div > div > div > div.css-175oi2r.r-6gpygo.r-14gqq1x > div.css-175oi2r.r-1wbh5a2.r-dnmrzs.r-1ny4l3l > div > div.css-175oi2r.r-1awozwy.r-18u37iz.r-1wbh5a2 > div > div > div > span';
function getId() {
    var a = document.querySelectorAll(idPosition)
    var b = Array.from(a)
    var c = b.map((x) => x.innerText);
    var data = c[0];

    try {
    return JSON.parse(data)['author'];
    } catch (e) {
        return 'not found';
    }
}

regex_url = /^https:\/\/twitter\.com\/(?!home$).+/;

var id = 'not found';
const observer = new MutationObserver(async (mutationList, observer) => {
    id = getId();
    if (id !== 'not found'){
        console.log('found id :' + id.identifier);
        observer.disconnect();
        await chrome.runtime.sendMessage({action: 'getMemo', id: id.identifier}, function(response) {
            memo = response.res;
            if (memo !== ''){
                console.log('memo is printed on document' + memo);
                Array.from(document.querySelectorAll(memoPosition))[0].textContent += ' : \'' + memo + '\'';
            }
        });
    }
});
const el = document.getElementsByTagName('head');
observer.observe(el[0], {
    childList: true,
    subtree: true,
    attributeOldValue: true,
});

chrome.runtime.onMessage.addListener(
    function(request, sender, sendResponse) {
        if (request.action !== 'tmemo_requestData') {
            return;
        }
        console.log('content.js:action=' + request.action);
        if (id === 'not found') {
            sendResponse({'id': 'not found'})
        }
        else{
            sendResponse({'id': id.identifier});
        }
    }
)
