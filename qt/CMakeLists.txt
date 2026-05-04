cmake_minimum_required(VERSION 3.20)
project(timehuddle-desktop VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)
set(CMAKE_AUTOUIC ON)
set(CMAKE_AUTORCC ON)

find_package(Qt6 REQUIRED COMPONENTS Core Network Widgets)

add_executable(timehuddle-desktop
    main.cpp
)

target_link_libraries(timehuddle-desktop
    Qt6::Core
    Qt6::Network
    Qt6::Widgets
)
